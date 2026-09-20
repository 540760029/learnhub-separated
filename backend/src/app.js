/**
 * LearnHub API —— 纯后端接口层（Node + MySQL）
 *
 * 本文件只提供 /api/* 的 JSON 接口，不托管静态资源；
 * 前端在独立的 frontend/ 项目中运行，跨源调用这里的接口（CORS 见文件末尾）。
 *
 * 为什么不用 Express：这里刻意保留 Fetch 风格的 Request/Response（路由自己写，
 * 见 src/router.js），业务代码因此不绑定任何 HTTP 框架 —— 测试里可以直接用
 * fetch 打真实端口，也可以用 handle() 直接调用。
 */
import { Db, nowIso, parseJson, randomJoinCode, toJson, today } from './db.js';
import { getConfig, SK } from './config.js';
import {
  createToken, decodeToken, decryptSecret, encryptSecret, hashPassword,
  maskKey, verifyPassword,
} from './security.js';
import {
  DEFAULT_PROVIDER, LlmError, PROVIDERS, analysisOk, canonicalAnswer,
  extractKnowledgePoints, generateQuestions, normalizeDifficulty,
} from './llm.js';
import { Router, httpError } from './router.js';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** 拆出「允许的跨源来源」：'*' 表示任意来源，否则是逗号分隔的白名单 */
function parseCorsOrigins(raw) {
  const value = String(raw ?? '*').trim();
  if (!value || value === '*') return { any: true, list: [] };
  return { any: false, list: value.split(',').map((s) => s.trim()).filter(Boolean) };
}

function corsHeaders(cors, origin) {
  const h = new Headers();
  // 未配置来源时放行任意来源；未带 Origin 的非浏览器请求（curl / 测试）不回该头
  const allow = cors.any ? (origin || '*') : (origin && cors.list.includes(origin) ? origin : '');
  if (!allow) return h;
  h.set('access-control-allow-origin', allow);
  if (allow !== '*') h.set('vary', 'Origin');
  h.set('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  h.set('access-control-allow-headers', 'Content-Type, Authorization');
  h.set('access-control-max-age', '86400');
  return h;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    is_admin: !!u.is_admin, school: u.school, student_no: u.student_no,
  };
}

export function createApp({ db, env }) {
  const cfg = getConfig(env);
  const app = new Router();

  // ---------------------------------------------------------------- 认证中间件
  app.use(async (c) => {
    const header = c.header('authorization') || '';
    const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : header.trim();
    const payload = token ? await decodeToken(cfg.secret, token) : null;
    if (payload) {
      const user = await db.getUserById(payload.sub);
      if (user && user.is_active) c.user = user;
    }
    return undefined;
  });

  const requireUser = (c) => {
    if (!c.user) throw httpError(401, '未登录或登录已过期');
    return c.user;
  };
  const requireAdmin = (c) => {
    const u = requireUser(c);
    if (!u.is_admin) throw httpError(403, '该操作仅平台管理员可用');
    return u;
  };

  /** 课程角色：admin | owner | teacher | student | none */
  async function courseRole(course, user) {
    if (!user) return 'none';
    if (user.is_admin) return 'admin';
    if (course.teacher_id === user.id) return 'owner';
    if (await db.isAssistingTeacher(course.id, user.id)) return 'teacher';
    if (user.role === 'student' && (await db.isEnrolled(course.id, user.id))) return 'student';
    return 'none';
  }

  const canManage = (role) => ['admin', 'owner', 'teacher'].includes(role);

  async function requireCourse(c, courseId, { manage = false } = {}) {
    const course = await db.getCourse(Number(courseId));
    if (!course) throw httpError(404, '课程不存在');
    const user = requireUser(c);
    const role = await courseRole(course, user);
    if (manage) {
      if (!canManage(role)) throw httpError(403, '只有该课程的教师可以执行此操作');
    } else if (role === 'none') {
      throw httpError(403, '你不在该课程中，请先加入课程');
    }
    return { course, role, user };
  }

  // ---------------------------------------------------------------- 可见性
  const visibleKps = (kps, role, user) => (canManage(role) ? kps
    : kps.filter((k) => k.scope === 'course' || (k.scope === 'private' && k.created_by === user.id)));

  const visibleQuizzes = (quizzes, role, user) => (canManage(role) ? quizzes
    : quizzes.filter((q) => q.scope === 'course' || (q.scope === 'private' && q.created_by === user.id)));

  const mayViewQuiz = (quiz, role, user) => {
    if (canManage(role)) return true;
    if (quiz.scope === 'teacher') return false;
    if (quiz.scope === 'private') return quiz.created_by === user.id;
    return true;
  };

  // ---------------------------------------------------------------- AI 额度
  async function dailyLimit() {
    const raw = await db.getSetting(SK.dailyLimit, String(cfg.dailyAiLimit));
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.trunc(n), 200) : cfg.dailyAiLimit;
  }

  async function platformConfig() {
    const s = await db.getSettings([
      SK.platformProvider, SK.platformKeyEnc, SK.platformBaseUrl, SK.platformModel, SK.platformEnabled,
    ]);
    let apiKey = '';
    if (s[SK.platformKeyEnc]) {
      try {
        apiKey = await decryptSecret(cfg.secret, s[SK.platformKeyEnc]);
      } catch {
        apiKey = '';
      }
    }
    if (!apiKey && cfg.platformApiKey) apiKey = cfg.platformApiKey;   // 容器初始化兜底
    const enabled = (s[SK.platformEnabled] ?? '1') === '1';
    return {
      configured: !!apiKey,
      enabled,
      provider: s[SK.platformProvider] || cfg.defaultProvider,
      apiKey: enabled ? apiKey : '',
      base_url: s[SK.platformBaseUrl] || '',
      model: s[SK.platformModel] || '',
    };
  }

  async function resolveAiConfig(user, course) {
    if (user.ai_api_key_enc) {
      let key = '';
      try {
        key = await decryptSecret(cfg.secret, user.ai_api_key_enc);
      } catch {
        key = '';
      }
      if (key) {
        return {
          provider: user.ai_provider || cfg.defaultProvider, api_key: key,
          base_url: user.ai_base_url || '', model: user.ai_model || '', source: 'own',
        };
      }
    }
    const plat = await platformConfig();
    if (user.is_admin) {
      return { provider: plat.provider, api_key: plat.apiKey, base_url: plat.base_url, model: plat.model, source: 'admin' };
    }
    if (course) {
      const owner = await db.getUserById(course.teacher_id);
      if (owner && owner.ai_api_key_enc) {
        try {
          const key = await decryptSecret(cfg.secret, owner.ai_api_key_enc);
          if (key) {
            return {
              provider: owner.ai_provider || cfg.defaultProvider, api_key: key,
              base_url: owner.ai_base_url || '', model: owner.ai_model || '', source: 'teacher',
            };
          }
        } catch { /* 回落到平台 key */ }
      }
    }
    return { provider: plat.provider, api_key: plat.apiKey, base_url: plat.base_url, model: plat.model, source: 'platform' };
  }

  async function quotaInfo(user) {
    const row = await db.getUsage(user.id);
    const hasOwn = !!user.ai_api_key_enc;
    const limit = await dailyLimit();
    const unlimited = hasOwn || !!user.is_admin;
    return {
      has_own_key: hasOwn,
      is_admin: !!user.is_admin,
      limit: unlimited ? null : limit,
      used: row.used,
      remaining: unlimited ? null : Math.max(0, limit - row.used),
      unlimited,
      reason: hasOwn ? 'own_key' : (user.is_admin ? 'admin' : null),
    };
  }

  // ================================================================ 认证
  app.post('/api/auth/register', async (c) => {
    const b = await c.body();
    const { email, name, password, role, school, student_no } = b;
    if (!email || !name || !password) throw httpError(400, '姓名、邮箱、密码都不能为空');
    if (String(password).length < 6) throw httpError(400, '密码至少 6 位');
    if (!['teacher', 'student'].includes(role)) throw httpError(400, '身份只能是 teacher 或 student');
    const mail = String(email).trim().toLowerCase();
    if (await db.getUserByEmail(mail)) throw httpError(400, '该邮箱已注册');

    const { lastRowId } = await db.run(
      `INSERT INTO users (email, name, role, is_admin, password_hash, school, student_no, is_active, created_at)
       VALUES (?,?,?,0,?,?,?,1,?)`,
      mail, String(name).trim(), role, await hashPassword(password),
      school || null, student_no || null, nowIso());
    const user = await db.getUserById(lastRowId);
    return c.json({
      token: await createToken(cfg.secret, { sub: user.id, role: user.role, name: user.name }, cfg.tokenTtl),
      user: publicUser(user),
    });
  });

  app.post('/api/auth/login', async (c) => {
    const { email, password } = await c.body();
    const user = await db.getUserByEmail(email);
    if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
      throw httpError(400, '邮箱或密码错误');
    }
    if (!user.is_active) throw httpError(403, '账号已停用');
    return c.json({
      token: await createToken(cfg.secret, { sub: user.id, role: user.role, name: user.name }, cfg.tokenTtl),
      user: publicUser(user),
    });
  });

  app.get('/api/me', async (c) => {
    const user = requireUser(c);
    let keyMasked = '';
    if (user.ai_api_key_enc) {
      try {
        keyMasked = maskKey(await decryptSecret(cfg.secret, user.ai_api_key_enc));
      } catch {
        keyMasked = '••••';
      }
    }
    return c.json({
      ...publicUser(user),
      ai: {
        provider: user.ai_provider || cfg.defaultProvider,
        base_url: user.ai_base_url || '',
        model: user.ai_model || '',
        key_masked: keyMasked,
        has_key: !!user.ai_api_key_enc,
      },
      quota: await quotaInfo(user),
    });
  });

  app.post('/api/me/ai-key', async (c) => {
    const user = requireUser(c);
    const { provider, api_key, base_url, model } = await c.body();
    if (provider && !PROVIDERS[provider]) throw httpError(400, '不支持的 AI 服务商');
    const enc = api_key && String(api_key).trim()
      ? await encryptSecret(cfg.secret, String(api_key).trim())
      : null;
    await db.run(
      'UPDATE users SET ai_provider = ?, ai_base_url = ?, ai_model = ?, ai_api_key_enc = ? WHERE id = ?',
      provider || cfg.defaultProvider, (base_url || '').trim() || null,
      (model || '').trim() || null, enc, user.id);
    const fresh = await db.getUserById(user.id);
    return c.json({ ok: true, ...(await quotaInfo(fresh)) });
  });

  app.get('/api/ai/providers', async (c) => {
    const plat = await platformConfig();
    return c.json({
      default: cfg.defaultProvider,
      platform_key_configured: plat.configured && plat.enabled,
      daily_limit: await dailyLimit(),
      scopes: [
        { id: 'course', label: '全班可见（学生都能看到并作答）' },
        { id: 'teacher', label: '仅教师可见（学生看不到）' },
        { id: 'private', label: '仅自己可见' },
      ],
      providers: Object.entries(PROVIDERS).map(([id, v]) => ({ id, ...v })),
    });
  });

  // ================================================================ 课程
  async function courseCard(course, role) {
    const counts = await db.courseCounts(course.id);
    const owner = await db.getUserById(course.teacher_id);
    return {
      id: course.id, title: course.title, description: course.description,
      cover_emoji: course.cover_emoji,
      join_code: role === 'student' ? null : course.join_code,
      is_published: !!course.is_published, teacher: owner ? owner.name : '', role,
      ...counts,
    };
  }

  app.get('/api/courses', async (c) => {
    const user = requireUser(c);
    if (user.role === 'teacher' || user.is_admin) {
      const owned = await db.listCoursesOwned(user.id);
      const assisting = await db.listCoursesAssisting(user.id);
      return c.json({
        teaching: await Promise.all(owned.map((x) => courseCard(x, 'owner'))),
        assisting: await Promise.all(assisting.map((x) => courseCard(x, 'teacher'))),
        joined: [],
      });
    }
    const joined = await db.listCoursesJoined(user.id);
    return c.json({
      teaching: [], assisting: [],
      joined: await Promise.all(joined.map((x) => courseCard(x, 'student'))),
    });
  });

  app.post('/api/courses', async (c) => {
    const user = requireUser(c);
    if (user.role !== 'teacher' && !user.is_admin) throw httpError(403, '该操作仅教师可用');
    const { title, description, cover_emoji } = await c.body();
    if (!title || !String(title).trim()) throw httpError(400, '课程名称不能为空');

    let code = randomJoinCode();
    for (let i = 0; i < 5; i++) {
      const dup = await db.first('SELECT 1 AS ok FROM courses WHERE join_code = ?', code);
      if (!dup) break;
      code = randomJoinCode();
    }
    const { lastRowId } = await db.run(
      `INSERT INTO courses (title, description, cover_emoji, join_code, teacher_id, is_published, created_at)
       VALUES (?,?,?,?,?,1,?)`,
      String(title).trim(), description || null, cover_emoji || '📘', code, user.id, nowIso());
    return c.json(await courseCard(await db.getCourse(lastRowId), 'owner'));
  });

  app.get('/api/courses/:cid', async (c) => {
    const { course, role, user } = await requireCourse(c, c.params.cid);

    const kps = await db.all(
      'SELECT * FROM knowledge_points WHERE course_id = ? ORDER BY order_no, id', course.id);
    const quizzes = await db.all(
      'SELECT * FROM quiz_sets WHERE course_id = ? ORDER BY created_at DESC', course.id);
    const assignments = await db.all(
      'SELECT * FROM assignments WHERE course_id = ? ORDER BY created_at DESC', course.id);
    const announcements = await db.all(
      'SELECT * FROM announcements WHERE course_id = ? ORDER BY created_at DESC LIMIT 20', course.id);

    const attempts = await db.all(
      'SELECT quiz_set_id, score FROM attempts WHERE student_id = ? ORDER BY submitted_at', user.id);
    const byQuiz = new Map();
    for (const a of attempts) {
      const cur = byQuiz.get(a.quiz_set_id) || { n: 0, best: null };
      cur.n += 1;
      cur.best = cur.best === null ? a.score : Math.max(cur.best, a.score);
      byQuiz.set(a.quiz_set_id, cur);
    }

    // 每套题的题目数量（一次聚合查询，避免逐套 N+1）
    const qCounts = new Map();
    if (quizzes.length) {
      const rows = await db.all(
        `SELECT quiz_set_id, COUNT(*) AS n FROM questions
          WHERE quiz_set_id IN (${quizzes.map(() => '?').join(',')})
          GROUP BY quiz_set_id`, ...quizzes.map((q) => q.id));
      for (const r of rows) qCounts.set(r.quiz_set_id, r.n);
    }

    return c.json({
      course: await courseCard(course, role),
      knowledge_points: visibleKps(kps, role, user).map((k) => ({
        id: k.id, title: k.title, content: k.content, order_no: k.order_no,
        scope: k.scope, created_by: k.created_by, source_file: k.source_file,
        mine: k.created_by === user.id,
      })),
      assignments: assignments.map((a) => ({
        id: a.id, title: a.title, due_at: a.due_at, full_score: a.full_score, content: a.content,
      })),
      quiz_sets: visibleQuizzes(quizzes, role, user).map((q) => {
        const info = byQuiz.get(q.id);
        return {
          id: q.id, title: q.title, source: q.source, scope: q.scope,
          created_by: q.created_by, mine: q.created_by === user.id, created_at: q.created_at,
          question_count: qCounts.get(q.id) || 0,
          attempt_count: info ? info.n : 0,
          best_score: info ? info.best : null,
        };
      }),
      announcements: announcements.map((a) => ({ id: a.id, content: a.content, created_at: a.created_at })),
      can_manage: canManage(role),
      my_role: role,
    });
  });

  app.patch('/api/courses/:cid', async (c) => {
    const { course } = await requireCourse(c, c.params.cid, { manage: true });
    const b = await c.body();
    const sets = [];
    const vals = [];
    if (b.title !== undefined) { sets.push('title = ?'); vals.push(String(b.title).trim()); }
    if (b.description !== undefined) { sets.push('description = ?'); vals.push(b.description); }
    if (b.cover_emoji !== undefined) { sets.push('cover_emoji = ?'); vals.push(b.cover_emoji); }
    if (b.is_published !== undefined) { sets.push('is_published = ?'); vals.push(b.is_published ? 1 : 0); }
    if (!sets.length) return c.json({ ok: true });
    await db.run(`UPDATE courses SET ${sets.join(', ')} WHERE id = ?`, ...vals, course.id);
    return c.json({ ok: true });
  });

  app.post('/api/courses/join', async (c) => {
    const user = requireUser(c);
    if (user.role !== 'student') throw httpError(400, '只有学生可以通过邀请码加入课程');
    const code = String((await c.body()).join_code || '').trim().toUpperCase();
    if (!code) throw httpError(400, '请输入邀请码');
    const course = await db.first('SELECT * FROM courses WHERE join_code = ?', code);
    if (!course) throw httpError(404, '邀请码无效');
    if (await db.isEnrolled(course.id, user.id)) {
      return c.json({ ok: true, course_id: course.id, message: '你已在该课程中' });
    }
    await db.run('INSERT INTO enrollments (course_id, student_id, created_at) VALUES (?,?,?)',
      course.id, user.id, nowIso());
    return c.json({ ok: true, course_id: course.id, message: `已加入《${course.title}》` });
  });

  app.get('/api/courses/:cid/students', async (c) => {
    const { course } = await requireCourse(c, c.params.cid, { manage: true });
    const students = await db.studentsOf(course.id);
    const out = [];
    for (const s of students) {
      const row = await db.first('SELECT COUNT(*) AS n FROM attempts WHERE student_id = ?', s.id);
      out.push({ id: s.id, name: s.name, email: s.email, student_no: s.student_no, attempts: row ? row.n : 0 });
    }
    return c.json({ students: out });
  });

  app.post('/api/courses/:cid/announcements', async (c) => {
    const { course } = await requireCourse(c, c.params.cid, { manage: true });
    const content = String((await c.body()).content || '').trim();
    if (!content) throw httpError(400, '内容不能为空');
    const { lastRowId } = await db.run(
      'INSERT INTO announcements (course_id, content, created_at) VALUES (?,?,?)',
      course.id, content, nowIso());
    return c.json({ ok: true, id: lastRowId });
  });

  // ================================================================ 知识点
  app.post('/api/courses/:cid/knowledge', async (c) => {
    const user = requireUser(c);
    let course; let role; let scope;
    const b = await c.body();
    if (user.role === 'student') {
      ({ course, role } = await requireCourse(c, c.params.cid));
      scope = 'private';                                    // 学生强制仅自己可见
    } else {
      ({ course, role } = await requireCourse(c, c.params.cid, { manage: true }));
      scope = ['course', 'teacher', 'private'].includes(b.scope) ? b.scope : 'course';
    }
    const title = String(b.title || '').trim();
    if (!title) throw httpError(400, '标题不能为空');
    const { lastRowId } = await db.run(
      `INSERT INTO knowledge_points (course_id, title, content, order_no, scope, created_by, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      course.id, title, String(b.content || ''), Number(b.order_no) || 0, scope, user.id, nowIso());
    return c.json({ ok: true, id: lastRowId, scope });
  });

  app.patch('/api/knowledge/:kid', async (c) => {
    const user = requireUser(c);
    const kp = await db.first('SELECT * FROM knowledge_points WHERE id = ?', Number(c.params.kid));
    if (!kp) throw httpError(404, '知识点不存在');
    const { role } = await requireCourse(c, kp.course_id);
    const mine = kp.scope === 'private' && kp.created_by === user.id;
    if (!canManage(role) && !mine) throw httpError(403, '你只能修改自己添加的知识点');

    const b = await c.body();
    const title = String(b.title || '').trim();
    if (!title) throw httpError(400, '标题不能为空');
    const scope = canManage(role) && ['course', 'teacher', 'private'].includes(b.scope) ? b.scope : kp.scope;
    await db.run('UPDATE knowledge_points SET title = ?, content = ?, order_no = ?, scope = ? WHERE id = ?',
      title, String(b.content || ''), Number(b.order_no) || 0, scope, kp.id);
    return c.json({ ok: true });
  });

  app.delete('/api/knowledge/:kid', async (c) => {
    const user = requireUser(c);
    const kp = await db.first('SELECT * FROM knowledge_points WHERE id = ?', Number(c.params.kid));
    if (!kp) throw httpError(404, '知识点不存在');
    const { role } = await requireCourse(c, kp.course_id);
    const mine = kp.scope === 'private' && kp.created_by === user.id;
    if (!canManage(role) && !mine) throw httpError(403, '你只能删除自己添加的知识点');
    await db.run('DELETE FROM knowledge_points WHERE id = ?', kp.id);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- 资料解析
  function extractFileText(filename, buf) {
    const name = String(filename || '').toLowerCase();
    if (name.endsWith('.pdf')) throw httpError(400, '暂不支持 PDF 直接解析，请先转成 Word 或 txt 再上传');
    if (name.endsWith('.docx')) {
      throw httpError(400, '暂不支持 .docx 在线解析（Workers 无 zip 解压环境），请另存为 .txt 或 .md 后上传');
    }
    if (!/\.(txt|md|markdown|csv|json|py|html)$/.test(name)) {
      throw httpError(400, '支持的文件类型：.txt / .md / .csv / .json');
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  /** 取上传文件：支持 JSON(base64) 与 multipart 两种 */
  async function readUpload(c) {
    const b = await c.body();
    if (b && b.content_base64) {
      const bin = Buffer.from(String(b.content_base64), 'base64');
      return { filename: String(b.filename || 'upload.txt'), buf: new Uint8Array(bin) };
    }
    const ct = c.header('content-type') || '';
    if (ct.includes('multipart/form-data')) {
      const raw = await c.raw();
      if (raw && raw.length) {
        const req2 = new Request('https://upload.local/', {
          method: 'POST', headers: { 'content-type': ct }, body: raw,
        });
        const form = await req2.formData();
        const file = form.get('file');
        if (file && typeof file !== 'string') {
          return { filename: file.name || 'upload.txt', buf: new Uint8Array(await file.arrayBuffer()) };
        }
      }
    }
    throw httpError(400, '没有收到文件：请以 JSON 提交 filename + content_base64，或用 multipart 字段名 file');
  }

  app.post('/api/courses/:cid/knowledge/extract', async (c) => {
    const { course } = await requireCourse(c, c.params.cid, { manage: true });
    const { filename, buf } = await readUpload(c);
    if (buf.byteLength > MAX_UPLOAD_BYTES) throw httpError(400, '文件太大（上限 8MB）');

    let text = extractFileText(filename, buf);
    text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 20) throw httpError(400, '文件里没有解析出有效文字内容');

    const ai = await resolveAiConfig(c.user, course);
    let points; let used;
    try {
      ({ points, provider: used } = await extractKnowledgePoints({
        provider: ai.provider, apiKey: ai.api_key, baseUrl: ai.base_url, model: ai.model,
        text, courseTitle: course.title,
      }));
    } catch (e) {
      if (e instanceof LlmError) throw httpError(400, `AI 整理失败：${e.message}`);
      throw e;
    }
    return c.json({
      filename, chars: text.length, provider: used,
      notice: used === 'mock' ? '未配置 API Key，已按标题/段落做启发式切分' : null,
      points,
    });
  });

  app.post('/api/courses/:cid/knowledge/commit', async (c) => {
    const { course, user } = await requireCourse(c, c.params.cid, { manage: true });
    const b = await c.body();
    const scope = ['course', 'teacher', 'private'].includes(b.scope) ? b.scope : 'course';
    const sourceFile = b.source_file || null;
    const points = Array.isArray(b.points) ? b.points : [];
    if (!points.length) throw httpError(400, '没有可保存的知识点');

    const maxRow = await db.first(
      'SELECT COALESCE(MAX(order_no), -1) AS n FROM knowledge_points WHERE course_id = ?', course.id);
    let base = (maxRow ? maxRow.n : -1) + 1;
    const titles = [];
    const stmts = [];
    for (const p of points) {
      const title = String((p && p.title) || '').trim();
      if (!title) continue;
      stmts.push(db.driver.prepare(
        `INSERT INTO knowledge_points (course_id, title, content, order_no, scope, created_by, source_file, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(course.id, title.slice(0, 200), String((p && p.content) || ''), base++, scope, user.id, sourceFile, nowIso()));
      titles.push(title);
    }
    if (!titles.length) throw httpError(400, '没有可保存的知识点');
    await db.batch(stmts);
    return c.json({ ok: true, created: titles.length, titles, scope });
  });

  // ================================================================ 作业
  app.post('/api/courses/:cid/assignments', async (c) => {
    const { course } = await requireCourse(c, c.params.cid, { manage: true });
    const b = await c.body();
    const title = String(b.title || '').trim();
    if (!title) throw httpError(400, '作业标题不能为空');
    const due = b.due_at ? String(b.due_at).replace('Z', '').trim() : null;
    if (due && Number.isNaN(Date.parse(due))) throw httpError(400, '截止时间格式不正确');
    const { lastRowId } = await db.run(
      `INSERT INTO assignments (course_id, title, content, due_at, full_score, created_at)
       VALUES (?,?,?,?,?,?)`,
      course.id, title, String(b.content || ''), due, Number(b.full_score) || 100, nowIso());
    return c.json({ ok: true, id: lastRowId });
  });

  app.get('/api/assignments/:aid', async (c) => {
    const a = await db.first('SELECT * FROM assignments WHERE id = ?', Number(c.params.aid));
    if (!a) throw httpError(404, '作业不存在');
    const { course, role, user } = await requireCourse(c, a.course_id);

    let mine = null;
    if (role === 'student') {
      const sub = await db.first(
        'SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?', a.id, user.id);
      if (sub) {
        mine = {
          content: sub.content, score: sub.score, feedback: sub.feedback, submitted_at: sub.submitted_at,
        };
      }
    }

    let submissions = [];
    if (canManage(role)) {
      const rows = await db.all(
        `SELECT s.*, u.name AS student FROM submissions s
           JOIN users u ON u.id = s.student_id
          WHERE s.assignment_id = ? ORDER BY s.submitted_at DESC`, a.id);
      submissions = rows.map((s) => ({
        id: s.id, student: s.student, student_id: s.student_id, content: s.content,
        score: s.score, feedback: s.feedback, submitted_at: s.submitted_at,
      }));
    }

    return c.json({
      id: a.id, title: a.title, content: a.content, full_score: a.full_score,
      due_at: a.due_at, course_id: a.course_id, course_title: course.title,
      my_submission: mine, submissions,
    });
  });

  app.post('/api/assignments/:aid/submit', async (c) => {
    const a = await db.first('SELECT * FROM assignments WHERE id = ?', Number(c.params.aid));
    if (!a) throw httpError(404, '作业不存在');
    const { role, user } = await requireCourse(c, a.course_id);
    if (role !== 'student') throw httpError(403, '只有学生可以提交作业');
    const content = String((await c.body()).content || '');
    // 「先更新、没命中再插入」：不依赖具体唯一索引名，并发下由唯一约束兜底
    await db.upsert({
      table: 'submissions',
      keyColumns: ['assignment_id', 'student_id'],
      values: {
        assignment_id: a.id,
        student_id: user.id,
        content,
        submitted_at: nowIso(),
      },
      updateColumns: ['content', 'submitted_at'],
    });
    const sub = await db.first(
      'SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?', a.id, user.id);
    return c.json({ ok: true, id: sub.id });
  });

  app.post('/api/submissions/:sid/grade', async (c) => {
    const sub = await db.first('SELECT * FROM submissions WHERE id = ?', Number(c.params.sid));
    if (!sub) throw httpError(404, '提交记录不存在');
    const a = await db.first('SELECT * FROM assignments WHERE id = ?', sub.assignment_id);
    await requireCourse(c, a.course_id, { manage: true });
    const b = await c.body();
    const score = Number(b.score);
    if (!Number.isFinite(score) || score < 0 || score > a.full_score) {
      throw httpError(400, `分数应在 0 ~ ${a.full_score} 之间`);
    }
    await db.run('UPDATE submissions SET score = ?, feedback = ?, graded_at = ? WHERE id = ?',
      score, b.feedback || null, nowIso(), sub.id);
    return c.json({ ok: true });
  });

  // ================================================================ 试题
  app.post('/api/courses/:cid/quizzes', async (c) => {
    const { course, user } = await requireCourse(c, c.params.cid, { manage: true });
    const b = await c.body();
    const questions = Array.isArray(b.questions) ? b.questions : [];
    if (!questions.length) throw httpError(400, '至少要有一道题');
    const title = String(b.title || '').trim() || '小测';

    const missing = [];
    const prepared = questions.map((q, i) => {
      let qtype = String((q && q.qtype) || 'single');
      if (!['single', 'multi', 'judge', 'short'].includes(qtype)) qtype = 'single';
      const options = Array.isArray(q && q.options) ? q.options.map((o) => String(o)) : null;
      const analysis = String((q && q.analysis) || '').trim();
      if (!analysis) missing.push(i + 1);
      return {
        qtype,
        stem: String((q && q.stem) || '').trim(),
        options,
        answer: canonicalAnswer(q && q.answer, qtype),
        analysis,
        difficulty: normalizeDifficulty(q && q.difficulty),
        kp_id: (q && q.kp_id) != null ? q.kp_id : null,
      };
    });
    if (missing.length) {
      throw httpError(400, `第 ${missing.join('、')} 题缺少解析，请补充后再创建（解析是学生自学的关键）`);
    }

    const { lastRowId: quizId } = await db.run(
      `INSERT INTO quiz_sets (course_id, title, source, scope, created_by, is_published, created_at)
       VALUES (?,?,?,?,?,1,?)`,
      course.id, title, 'manual', 'course', user.id, nowIso());
    await db.batch(prepared.map((q, i) => db.driver.prepare(
      `INSERT INTO questions (quiz_set_id, qtype, stem, options, answer, analysis, difficulty, kp_id, order_no)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(quizId, q.qtype, q.stem, toJson(q.options), q.answer, q.analysis, q.difficulty, q.kp_id, i)));
    return c.json({ ok: true, id: quizId });
  });

  app.patch('/api/quizzes/:qid/scope', async (c) => {
    const qs = await db.first('SELECT * FROM quiz_sets WHERE id = ?', Number(c.params.qid));
    if (!qs) throw httpError(404, '试题不存在');
    const { user } = await requireCourse(c, qs.course_id, { manage: true });
    const scope = String((await c.body()).scope || '');
    if (!['course', 'teacher', 'private'].includes(scope)) throw httpError(400, '可见性取值不合法');
    if (scope === 'private' && !user.is_admin) {
      throw httpError(400, '教师试卷不支持设为「仅自己可见」，请用「仅教师可见」');
    }
    await db.run('UPDATE quiz_sets SET scope = ? WHERE id = ?', scope, qs.id);
    return c.json({ ok: true, scope });
  });

  async function loadQuiz(qid) {
    const qs = await db.first('SELECT * FROM quiz_sets WHERE id = ?', Number(qid));
    if (!qs) throw httpError(404, '试题不存在');
    const questions = await db.all(
      'SELECT * FROM questions WHERE quiz_set_id = ? ORDER BY order_no, id', qs.id);
    return { qs, questions };
  }

  function questionPublic(q, withAnswer) {
    const base = {
      id: q.id, qtype: q.qtype, stem: q.stem, options: parseJson(q.options, null),
      difficulty: Number.isInteger(q.difficulty) ? q.difficulty : normalizeDifficulty(q.difficulty),
      kp_id: q.kp_id, order_no: q.order_no,
    };
    if (withAnswer) {
      base.answer = q.answer || '';
      base.analysis = String(q.analysis || '').trim() || '（本题暂无解析）';
    }
    return base;
  }

  app.get('/api/quizzes/:qid', async (c) => {
    const { qs, questions } = await loadQuiz(c.params.qid);
    const { role, user } = await requireCourse(c, qs.course_id);
    if (!mayViewQuiz(qs, role, user)) throw httpError(403, '无权查看该试题');
    return c.json({
      id: qs.id, title: qs.title, source: qs.source, course_id: qs.course_id,
      created_at: qs.created_at, question_count: questions.length,
      scope: qs.scope, mine: qs.created_by === user.id, can_manage: canManage(role),
      questions: questions.map((q) => questionPublic(q, canManage(role))),
    });
  });

  app.get('/api/quizzes/:qid/overview', async (c) => {
    const { qs, questions } = await loadQuiz(c.params.qid);
    await requireCourse(c, qs.course_id, { manage: true });

    const attempts = await db.all(
      `SELECT a.*, u.name AS student, u.student_no AS student_no FROM attempts a
         JOIN users u ON u.id = a.student_id
        WHERE a.quiz_set_id = ? ORDER BY a.submitted_at DESC`, qs.id);

    const perQ = new Map(questions.map((q) => [q.id, { question_id: q.id, stem: q.stem, total: 0, correct: 0 }]));
    for (const a of attempts) {
      for (const d of parseJson(a.detail, []) || []) {
        const st = perQ.get(d.question_id);
        if (!st) continue;
        st.total += 1;
        if (d.correct) st.correct += 1;
      }
    }
    const questionsStat = questions.map((q) => {
      const st = perQ.get(q.id);
      return { ...st, accuracy: st.total ? Math.round((st.correct / st.total) * 1000) / 10 : null };
    });
    const accs = attempts.filter((a) => a.total > 0).map((a) => (a.score / a.total) * 100);

    return c.json({
      quiz: {
        id: qs.id, title: qs.title, source: qs.source, course_id: qs.course_id,
        question_count: questions.length, scope: qs.scope,
        questions: questions.map((q) => questionPublic(q, true)),
      },
      scope: qs.scope,
      stats: {
        attempt_count: attempts.length,
        student_count: new Set(attempts.map((a) => a.student_id)).size,
        avg_accuracy: accs.length ? Math.round((accs.reduce((x, y) => x + y, 0) / accs.length) * 10) / 10 : null,
        highest: accs.length ? Math.round(Math.max(...accs) * 10) / 10 : null,
        lowest: accs.length ? Math.round(Math.min(...accs) * 10) / 10 : null,
      },
      questions_stat: questionsStat,
      attempts: attempts.map((a) => ({
        id: a.id, student_id: a.student_id, student: a.student, student_no: a.student_no,
        score: a.score, total: a.total,
        accuracy: a.total ? Math.round((a.score / a.total) * 1000) / 10 : 0,
        submitted_at: a.submitted_at,
        wrong: (parseJson(a.detail, []) || []).filter((d) => !d.correct).map((d) => d.question_id),
      })),
    });
  });

  app.delete('/api/quizzes/:qid', async (c) => {
    const qs = await db.first('SELECT * FROM quiz_sets WHERE id = ?', Number(c.params.qid));
    if (!qs) throw httpError(404, '试题不存在');
    await requireCourse(c, qs.course_id, { manage: true });
    await db.run('DELETE FROM quiz_sets WHERE id = ?', qs.id);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- 答题
  const isAnswered = (answers, qid) => {
    const v = (answers || {})[String(qid)];
    return v !== undefined && v !== null && String(v).trim() !== '';
  };

  function reviewSummary(questions, answers, detail) {
    const wrongIds = new Set((detail || []).filter((d) => !d.correct).map((d) => d.question_id));
    const answered = [];
    const unanswered = [];
    for (const q of questions) (isAnswered(answers, q.id) ? answered : unanswered).push(q.id);
    const index = new Map(questions.map((q, i) => [q.id, i + 1]));
    const wrongAnswered = [...wrongIds].filter((id) => index.has(id) && !unanswered.includes(id));
    return {
      total: questions.length,
      answered_count: answered.length,
      unanswered_count: unanswered.length,
      wrong_count: wrongAnswered.length,
      correct_count: answered.length - wrongAnswered.length,
      answered_ids: answered,
      unanswered_ids: unanswered,
      unanswered: unanswered.map((id) => ({ id, no: index.get(id) })),
      wrong: wrongAnswered.map((id) => ({ id, no: index.get(id) })),
    };
  }

  function reviewPayload(questions, answers, detail) {
    const dmap = new Map((detail || []).map((d) => [d.question_id, !!d.correct]));
    return questions.map((q) => ({
      id: q.id, stem: q.stem, options: parseJson(q.options, null), qtype: q.qtype,
      answer: q.answer || '',
      analysis: String(q.analysis || '').trim() || '（本题暂无解析）',
      difficulty: Number.isInteger(q.difficulty) ? q.difficulty : normalizeDifficulty(q.difficulty),
      kp_id: q.kp_id,
      given: String((answers || {})[String(q.id)] ?? ''),
      answered: isAnswered(answers, q.id),
      correct: !!dmap.get(q.id),
    }));
  }

  app.post('/api/quizzes/:qid/submit', async (c) => {
    const { qs, questions } = await loadQuiz(c.params.qid);
    const { role, user } = await requireCourse(c, qs.course_id);
    if (!mayViewQuiz(qs, role, user)) throw httpError(403, '无权作答该试题');
    if (role !== 'student') throw httpError(403, '只有学生可以作答');
    if (!questions.length) throw httpError(400, '这套题还没有题目');

    const b = await c.body();
    const answers = b.answers && typeof b.answers === 'object' ? b.answers : {};
    let score = 0;
    const detail = questions.map((q) => {
      const given = String(answers[String(q.id)] ?? '').trim().toUpperCase().replace(/\s+/g, '');
      const expect = String(q.answer || '').trim().toUpperCase().replace(/\s+/g, '');
      const correct = !!expect && given === expect;
      if (correct) score += 1;
      return { question_id: q.id, kp_id: q.kp_id, correct, given, answer: q.answer };
    });

    const { lastRowId } = await db.run(
      `INSERT INTO attempts (quiz_set_id, student_id, answers, score, total, detail, duration_sec, submitted_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      qs.id, user.id, toJson(answers), score, questions.length, toJson(detail),
      Number(b.duration_sec) || 0, nowIso());

    await db.bumpWeakStats(user.id, detail);

    return c.json({
      attempt_id: lastRowId,
      score, total: questions.length,
      accuracy: Math.round((score / questions.length) * 1000) / 10,
      summary: reviewSummary(questions, answers, detail),
      review: reviewPayload(questions, answers, detail),
    });
  });

  app.get('/api/my/attempts', async (c) => {
    const user = requireUser(c);
    const rows = await db.all(
      `SELECT a.*, q.title AS quiz_title, c.title AS course FROM attempts a
         JOIN quiz_sets q ON q.id = a.quiz_set_id
         JOIN courses   c ON c.id = q.course_id
        WHERE a.student_id = ? ORDER BY a.submitted_at DESC LIMIT 50`, user.id);
    return c.json({
      attempts: rows.map((a) => ({
        id: a.id, quiz_id: a.quiz_set_id, quiz_title: a.quiz_title, course: a.course,
        score: a.score, total: a.total,
        accuracy: a.total ? Math.round((a.score / a.total) * 1000) / 10 : 0,
        submitted_at: a.submitted_at,
      })),
    });
  });

  app.get('/api/attempts/:aid', async (c) => {
    const user = requireUser(c);
    const a = await db.first('SELECT * FROM attempts WHERE id = ?', Number(c.params.aid));
    if (!a) throw httpError(404, '记录不存在');
    if (a.student_id !== user.id && user.role !== 'teacher' && !user.is_admin) {
      throw httpError(403, '无权查看');
    }
    const { qs, questions } = await loadQuiz(a.quiz_set_id);
    const answers = parseJson(a.answers, {}) || {};
    const detail = parseJson(a.detail, []) || [];
    return c.json({
      id: a.id, score: a.score, total: a.total,
      accuracy: a.total ? Math.round((a.score / a.total) * 1000) / 10 : 0,
      submitted_at: a.submitted_at, quiz_title: qs.title,
      quiz_id: qs.id, course_id: qs.course_id,
      summary: reviewSummary(questions, answers, detail),
      review: reviewPayload(questions, answers, detail),
    });
  });

  // ================================================================ AI 出题
  app.get('/api/courses/:cid/ai-quota', async (c) => {
    const { course, user } = await requireCourse(c, c.params.cid);
    const info = await quotaInfo(user);
    const ai = await resolveAiConfig(user, course);
    return c.json({
      ...info,
      key_source: ai.source,
      provider: ai.provider,
      will_fallback_mock: !ai.api_key,
    });
  });

  app.get('/api/courses/:cid/weak-points', async (c) => {
    const { course, user } = await requireCourse(c, c.params.cid);
    const kps = await db.all('SELECT id, title FROM knowledge_points WHERE course_id = ?', course.id);
    const titleById = new Map(kps.map((k) => [k.id, k.title]));
    const rows = await db.all('SELECT * FROM weak_stats WHERE student_id = ?', user.id);
    const out = rows
      .filter((r) => titleById.has(r.kp_id))
      .map((r) => ({
        kp_id: r.kp_id, title: titleById.get(r.kp_id), total: r.total, wrong: r.wrong,
        wrong_rate: r.total ? Math.round((r.wrong / r.total) * 1000) / 10 : 0,
      }));
    out.sort((a, b) => b.wrong_rate - a.wrong_rate || b.wrong - a.wrong);
    return c.json({ weak_points: out });
  });

  app.post('/api/ai/generate', async (c) => {
    const body = await c.body();
    const { course, role, user } = await requireCourse(c, body.course_id);

    const wanted = Array.isArray(body.kp_ids) ? body.kp_ids.map(Number) : [];
    let kps = await db.all(
      'SELECT * FROM knowledge_points WHERE course_id = ? ORDER BY order_no, id', course.id);
    kps = visibleKps(kps, role, user);
    if (wanted.length) kps = kps.filter((k) => wanted.includes(k.id));
    if (!kps.length) throw httpError(400, '该课程还没有知识点，请先让老师发布知识点');

    const ai = await resolveAiConfig(user, course);
    const quota = await quotaInfo(user);
    if (!quota.unlimited && quota.used >= quota.limit) {
      throw httpError(429, `今日 AI 出题额度已用完（${quota.limit} 套/天）。你可以在「设置」里填入自己的 API Key 解除限制。`);
    }

    const qtype = ['single', 'multi', 'judge', 'mixed'].includes(body.qtype) ? body.qtype : 'single';
    const difficulty = ['easy', 'medium', 'hard', 'mixed'].includes(body.difficulty) ? body.difficulty : 'medium';

    let questions; let provider; let dropped = 0;
    try {
      ({ questions, provider, dropped } = await generateQuestions({
        provider: ai.provider, apiKey: ai.api_key, baseUrl: ai.base_url, model: ai.model,
        kpTitles: kps.map((k) => k.title), kpContents: kps.map((k) => k.content || ''),
        count: body.count, qtype, difficulty, extra: String(body.extra || ''),
      }));
    } catch (e) {
      if (e instanceof LlmError) throw httpError(400, `AI 出题失败：${e.message}`);
      throw e;
    }

    let scope = body.scope && body.scope !== 'auto' ? body.scope : (canManage(role) ? 'course' : 'private');
    if (!['course', 'teacher', 'private'].includes(scope)) scope = canManage(role) ? 'course' : 'private';
    if (scope !== 'private' && !canManage(role)) throw httpError(403, '学生生成的试题只能自己可见');
    if (scope === 'course' && !canManage(role)) throw httpError(403, '只有教师可以把试题发布给全班');

    const title = `AI 智能练习 · ${kps.slice(0, 2).map((k) => k.title).join('/')}${kps.length > 2 ? '…' : ''}`;
    const { lastRowId: quizId } = await db.run(
      `INSERT INTO quiz_sets (course_id, title, source, scope, kp_ids, created_by, is_published, created_at)
       VALUES (?,?,?,?,?,?,1,?)`,
      course.id, title, 'ai', scope, toJson(kps.map((k) => k.id)), user.id, nowIso());

    await db.batch(questions.map((q, i) => db.driver.prepare(
      `INSERT INTO questions (quiz_set_id, qtype, stem, options, answer, analysis, difficulty, kp_id, order_no)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(quizId, q.qtype, q.stem, toJson(q.options), q.answer, q.analysis, q.difficulty,
      kps[i % kps.length].id, i)));

    await db.bumpUsage(user.id, { ownKey: ai.source === 'own' || ai.source === 'admin' });

    return c.json({
      quiz_id: quizId, title, count: questions.length, scope, provider,
      key_source: ai.source, dropped,
      quota: await quotaInfo(await db.getUserById(user.id)),
      notice: provider === 'mock' ? '当前为离线模拟题（未配置 API Key）' : null,
    });
  });

  // ================================================================ 教师看板
  app.get('/api/courses/:cid/analytics', async (c) => {
    const { course } = await requireCourse(c, c.params.cid, { manage: true });
    const students = await db.studentsOf(course.id);
    const kps = await db.all('SELECT id, title FROM knowledge_points WHERE course_id = ?', course.id);
    const kpTitle = new Map(kps.map((k) => [k.id, k.title]));
    const quizzes = await db.all('SELECT id FROM quiz_sets WHERE course_id = ?', course.id);
    const quizIds = quizzes.map((q) => q.id);
    const assignments = await db.all('SELECT id FROM assignments WHERE course_id = ?', course.id);
    const asgIds = assignments.map((a) => a.id);

    const rows = [];
    for (const s of students) {
      let attempts = [];
      if (quizIds.length) {
        attempts = await db.all(
          `SELECT * FROM attempts WHERE student_id = ? AND quiz_set_id IN (${quizIds.map(() => '?').join(',')})`,
          s.id, ...quizIds);
      }
      let subs = [];
      if (asgIds.length) {
        subs = await db.all(
          `SELECT * FROM submissions WHERE student_id = ? AND assignment_id IN (${asgIds.map(() => '?').join(',')})`,
          s.id, ...asgIds);
      }
      const totalQ = attempts.reduce((n, a) => n + a.total, 0);
      const gotQ = attempts.reduce((n, a) => n + a.score, 0);
      const graded = subs.filter((x) => x.score !== null).map((x) => x.score);
      rows.push({
        student_id: s.id, name: s.name, student_no: s.student_no, email: s.email,
        quiz_attempts: attempts.length,
        quiz_accuracy: totalQ ? Math.round((gotQ / totalQ) * 1000) / 10 : null,
        submitted: subs.length,
        graded: graded.length,
        avg_score: graded.length ? Math.round((graded.reduce((a, b) => a + b, 0) / graded.length) * 10) / 10 : null,
      });
    }

    const weakRows = await db.all(
      `SELECT w.kp_id, SUM(w.total) AS total, SUM(w.wrong) AS wrong FROM weak_stats w
         JOIN enrollments e ON e.student_id = w.student_id AND e.course_id = ?
        GROUP BY w.kp_id`, course.id);
    const weak = weakRows
      .filter((r) => kpTitle.has(r.kp_id) && r.total)
      .map((r) => ({
        kp_id: r.kp_id, title: kpTitle.get(r.kp_id), total: r.total, wrong: r.wrong || 0,
        wrong_rate: Math.round(((r.wrong || 0) / r.total) * 1000) / 10,
      }))
      .sort((a, b) => b.wrong_rate - a.wrong_rate)
      .slice(0, 10);

    let trend = [];
    if (quizIds.length) {
      const rows2 = await db.all(
        `SELECT * FROM attempts WHERE quiz_set_id IN (${quizIds.map(() => '?').join(',')})
          ORDER BY submitted_at`, ...quizIds);
      trend = rows2.slice(-60).map((a) => ({
        date: String(a.submitted_at).slice(0, 10),
        accuracy: a.total ? Math.round((a.score / a.total) * 1000) / 10 : 0,
      }));
    }

    const counts = await db.courseCounts(course.id);
    return c.json({
      course: { id: course.id, title: course.title, join_code: course.join_code, ...counts },
      students: rows,
      weak_knowledge_points: weak,
      trend,
    });
  });

  // ================================================================ 管理员
  app.get('/api/admin/stats', async (c) => {
    requireAdmin(c);
    const one = async (sql, ...p) => {
      const r = await db.first(sql, ...p);
      return r ? r.n : 0;
    };
    const plat = await platformConfig();
    return c.json({
      users: await one('SELECT COUNT(*) AS n FROM users'),
      teachers: await one("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'"),
      students: await one("SELECT COUNT(*) AS n FROM users WHERE role = 'student'"),
      admins: await one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
      courses: await one('SELECT COUNT(*) AS n FROM courses'),
      knowledge_points: await one('SELECT COUNT(*) AS n FROM knowledge_points'),
      assignments: await one('SELECT COUNT(*) AS n FROM assignments'),
      submissions: await one('SELECT COUNT(*) AS n FROM submissions'),
      quiz_sets: await one('SELECT COUNT(*) AS n FROM quiz_sets'),
      questions: await one('SELECT COUNT(*) AS n FROM questions'),
      attempts: await one('SELECT COUNT(*) AS n FROM attempts'),
      ai_generations_today: await db.sumUsageToday(),
      platform_key_configured: plat.configured,
      daily_ai_limit: await dailyLimit(),
    });
  });

  app.get('/api/admin/platform-ai', async (c) => {
    requireAdmin(c);
    const plat = await platformConfig();
    const encRow = await db.getSetting(SK.platformKeyEnc, null);
    return c.json({
      configured: plat.configured,
      enabled: plat.enabled,
      provider: plat.provider,
      base_url: plat.base_url,
      model: plat.model,
      key_masked: plat.configured ? maskKey(plat.apiKey) : '',
      source: encRow ? 'db' : (cfg.platformApiKey ? 'env' : 'none'),
      daily_limit: await dailyLimit(),
      env_fallback_available: !!cfg.platformApiKey,
      usage_today: await db.sumUsageToday(),
    });
  });

  app.post('/api/admin/platform-ai', async (c) => {
    requireAdmin(c);
    const b = await c.body();
    if (b.provider && !PROVIDERS[b.provider]) throw httpError(400, '不支持的 AI 服务商');
    if (b.provider) await db.setSetting(SK.platformProvider, b.provider);
    if (b.base_url !== undefined) await db.setSetting(SK.platformBaseUrl, String(b.base_url).trim());
    if (b.model !== undefined) await db.setSetting(SK.platformModel, String(b.model).trim());
    if (b.enabled !== undefined) await db.setSetting(SK.platformEnabled, b.enabled ? '1' : '0');
    if (b.daily_limit !== undefined) {
      const n = Math.max(1, Math.min(Number(b.daily_limit) || 3, 200));
      await db.setSetting(SK.dailyLimit, String(n));
    }
    if (b.clear_key) {
      await db.setSetting(SK.platformKeyEnc, null);
    } else if (b.api_key && String(b.api_key).trim()) {
      await db.setSetting(SK.platformKeyEnc, await encryptSecret(cfg.secret, String(b.api_key).trim()));
    }
    const plat = await platformConfig();
    return c.json({
      ok: true, configured: plat.configured, enabled: plat.enabled,
      key_masked: plat.configured ? maskKey(plat.apiKey) : '',
      daily_limit: await dailyLimit(),
    });
  });

  app.post('/api/admin/platform-ai/test', async (c) => {
    requireAdmin(c);
    const plat = await platformConfig();
    if (!plat.configured) throw httpError(400, '还没有配置平台 API Key');
    if (!plat.enabled) throw httpError(400, '平台 AI 当前处于停用状态');
    const cfgP = PROVIDERS[plat.provider] || PROVIDERS[DEFAULT_PROVIDER];
    const url = (plat.base_url || cfgP.base_url).replace(/\/+$/, '') + '/chat/completions';
    const model = plat.model || cfgP.model;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${plat.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages: [{ role: 'user', content: '回复：可用' }], max_tokens: 16, stream: false,
        }),
      });
    } catch (e) {
      throw httpError(400, `测试失败：无法连接（${e.message}）`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw httpError(400, `测试失败：HTTP ${resp.status} ${text.slice(0, 200)}`);
    }
    const data = await resp.json().catch(() => null);
    return c.json({
      ok: true, provider: plat.provider, base_url: plat.base_url || cfgP.base_url, model,
      reply: String((data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.content) || '').trim().slice(0, 60),
    });
  });

  app.get('/api/admin/users', async (c) => {
    requireAdmin(c);
    const q = String(c.query('q') || '').trim();
    let rows;
    if (q) {
      const like = `%${q}%`;
      rows = await db.all(
        'SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR student_no LIKE ? ORDER BY id LIMIT 500',
        like, like, like);
    } else {
      rows = await db.all('SELECT * FROM users ORDER BY id LIMIT 500');
    }
    const out = [];
    for (const u of rows) {
      const cr = await db.first('SELECT COUNT(*) AS n FROM courses WHERE teacher_id = ?', u.id);
      const ar = await db.first('SELECT COUNT(*) AS n FROM attempts WHERE student_id = ?', u.id);
      out.push({
        id: u.id, name: u.name, email: u.email, role: u.role,
        is_admin: !!u.is_admin, is_active: !!u.is_active,
        school: u.school, student_no: u.student_no,
        has_own_key: !!u.ai_api_key_enc, created_at: u.created_at,
        course_count: cr ? cr.n : 0,
        attempt_count: ar ? ar.n : 0,
      });
    }
    return c.json({ users: out });
  });

  app.patch('/api/admin/users/:uid', async (c) => {
    const admin = requireAdmin(c);
    const u = await db.getUserById(Number(c.params.uid));
    if (!u) throw httpError(404, '用户不存在');
    const b = await c.body();
    if (u.id === admin.id && b.is_admin === false) throw httpError(400, '不能取消自己的管理员权限');
    if (u.id === admin.id && b.is_active === false) throw httpError(400, '不能停用自己的账号');

    const sets = [];
    const vals = [];
    if (b.role !== undefined) {
      if (!['teacher', 'student'].includes(b.role)) throw httpError(400, '角色取值不合法');
      sets.push('role = ?'); vals.push(b.role);
    }
    if (b.is_admin !== undefined) { sets.push('is_admin = ?'); vals.push(b.is_admin ? 1 : 0); }
    if (b.is_active !== undefined) { sets.push('is_active = ?'); vals.push(b.is_active ? 1 : 0); }
    if (!sets.length) return c.json({ ok: true });
    await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, u.id);
    return c.json({ ok: true });
  });

  app.delete('/api/admin/users/:uid', async (c) => {
    const admin = requireAdmin(c);
    const u = await db.getUserById(Number(c.params.uid));
    if (!u) throw httpError(404, '用户不存在');
    if (u.id === admin.id) throw httpError(400, '不能删除自己的账号');
    await db.run('DELETE FROM users WHERE id = ?', u.id);
    return c.json({ ok: true, deleted: u.name });
  });

  app.get('/api/admin/courses', async (c) => {
    requireAdmin(c);
    const courses = await db.all('SELECT * FROM courses ORDER BY created_at DESC LIMIT 500');
    const out = [];
    for (const x of courses) {
      const owner = await db.getUserById(x.teacher_id);
      const counts = await db.courseCounts(x.id);
      const sub = await db.first(
        `SELECT COUNT(*) AS n FROM submissions s
           JOIN assignments a ON a.id = s.assignment_id WHERE a.course_id = ?`, x.id);
      out.push({
        id: x.id, title: x.title, teacher: owner ? owner.name : '', teacher_id: x.teacher_id,
        join_code: x.join_code, is_published: !!x.is_published, created_at: x.created_at,
        ...counts, submission_count: sub ? sub.n : 0,
      });
    }
    return c.json({ courses: out });
  });

  app.delete('/api/admin/courses/:cid', async (c) => {
    requireAdmin(c);
    const x = await db.getCourse(Number(c.params.cid));
    if (!x) throw httpError(404, '课程不存在');
    await db.run('DELETE FROM courses WHERE id = ?', x.id);
    return c.json({ ok: true, deleted: x.title });
  });

  // ================================================================ 静态资源
  // 本服务只对外提供 /api/*；前端静态资源由 frontend/ 独立托管。
  // 因此非 /api/* 的请求会落到 router 的默认 404（JSON），不做 SPA 回退。

  app.onError((err, c) => {
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error('[error]', err);
    return c.json({ detail: (err && err.message) || '服务器内部错误' }, status);
  });

  // ---------------------------------------------------------------- CORS
  // 包在 handle 外层，保证 404 / 401 / 500 等所有响应都带回跨源头，
  // 否则前端拿到的失败响应会被浏览器直接拦掉，只能看到 "Failed to fetch"。
  const cors = parseCorsOrigins(cfg.corsOrigin);
  const inner = app.handle.bind(app);

  app.handle = async (req, envArg = {}, ctx = {}) => {
    const origin = req.headers.get('origin') || '';

    // 预检：浏览器发 JSON + Authorization 前必然先来一次 OPTIONS
    if (req.method === 'OPTIONS' && req.headers.get('access-control-request-method')) {
      return new Response(null, { status: 204, headers: corsHeaders(cors, origin) });
    }

    const res = await inner(req, envArg, ctx);
    const headers = new Headers(res.headers);
    corsHeaders(cors, origin).forEach((v, k) => headers.set(k, v));
    // 204/304 不允许带 body
    const body = res.status === 204 || res.status === 304 ? null : res.body;
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  };

  return app;
}
