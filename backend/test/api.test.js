/**
 * LearnHub 后端端到端测试（跑在真实 MySQL 上）
 *
 *   npm test
 *
 * 每次运行都会 DROP 并重建独立的 learnhub_test 库，再对着真实 HTTP 端口逐条打接口：
 *   认证 / 多教师隔离 / 知识点可见性 / 作业 / 试题 / 答题 / AI 额度 / 管理员 / CORS
 *
 * 这些用例跑在真实 MySQL 上，因此同时也在验证 MySQL 方言
 *（保留字 `key`、VARCHAR/TEXT、索引、唯一约束错误码等）没有踩坑。
 *
 * 配置：LEARNHUB_TEST_DB_URL（见 backend/.env.example）。
 *      测试只读这个变量，绝不读 LEARNHUB_DB_URL，避免误伤业务库。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { bootstrap } from '../src/bootstrap.js';
import { createNodeServer } from '../src/node-adapter.js';
import { prepareTestDatabase } from './setup-mysql.js';

let server;
let base;
let driver;

/** 测试里当作「前端」的来源，用来验证 CORS 白名单 */
const FRONTEND_ORIGIN = 'http://127.0.0.1:5173';

// ------------------------------------------------------------------ 工具
async function api(method, url, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) {
    payload = raw;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + url, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _text: text };
  }
  return { status: res.status, data };
}

const get = (u, o) => api('GET', u, o);
const post = (u, b, o = {}) => api('POST', u, { ...o, body: b });
const patch = (u, b, o = {}) => api('PATCH', u, { ...o, body: b });
const del = (u, o) => api('DELETE', u, o);

let teacher;
let teacher2;
let student;
let student2;
let admin;

before(async () => {
  // 1) 重建独立的测试库（learnhub_test）并建表，保证每次从空表开始
  const prepared = await prepareTestDatabase();
  driver = prepared.driver;

  // 2) 用与 server.js 相同的装配方式（这里直接复用已建好的连接池）
  const boot = await bootstrap({
    driver,
    seed: false,
    env: {
      LEARNHUB_SECRET: 'test-secret',
      LEARNHUB_DAILY_AI_LIMIT: '3',
      LEARNHUB_CORS_ORIGIN: FRONTEND_ORIGIN,
    },
  });
  const { app, db } = boot;

  // 3) 占一个空闲端口起真实 HTTP 服务
  const nodeServer = await createNodeServer(app, { env: boot.env, port: 0, host: '127.0.0.1' });
  server = nodeServer;
  base = `http://127.0.0.1:${nodeServer.address().port}`;

  // 建测试数据（比演示数据多一个教师、一个学生，便于验证隔离）
  const { hashPassword } = await import('../src/security.js');
  const pw = await hashPassword('demo1234');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const mk = (email, name, role, isAdmin = 0) => db.run(
    `INSERT INTO users (email,name,role,is_admin,password_hash,is_active,created_at)
     VALUES (?,?,?,?,?,1,?)`, email, name, role, isAdmin, pw, now);
  const t = await mk('teacher@demo.edu', '张明', 'teacher');
  const t2 = await mk('teacher2@demo.edu', '王老师', 'teacher');
  const s = await mk('student@demo.edu', '李小凡', 'student');
  const s2 = await mk('student2@demo.edu', '李四', 'student');
  const a = await mk('admin@demo.edu', '平台管理员', 'teacher', 1);
  teacher = t.lastRowId;
  teacher2 = t2.lastRowId;
  student = s.lastRowId;
  student2 = s2.lastRowId;
  admin = a.lastRowId;

  // 教师1 建课
  const c = await db.run(
    `INSERT INTO courses (title,description,cover_emoji,join_code,teacher_id,is_published,created_at)
     VALUES (?,?,?,?,?,1,?)`,
    '多传感器信息融合滤波技术', '测试课程', '🛰️', 'DEMO01', teacher, now);
  const cid = c.lastRowId;
  await db.run('INSERT INTO enrollments (course_id,student_id,created_at) VALUES (?,?,?)', cid, student, now);
  await db.run(
    `INSERT INTO knowledge_points (course_id,title,content,order_no,scope,created_by,created_at)
     VALUES (?,?,?,?,?,?,?)`, cid, '卡尔曼滤波基础', '卡尔曼滤波是递推最小方差估计。', 0, 'course', teacher, now);

  // 登录拿 token
  const tok = async (email) => (await post('/api/auth/login', { email, password: 'demo1234' })).data.token;
  globalThis.T = {
    teacher: await tok('teacher@demo.edu'),
    teacher2: await tok('teacher2@demo.edu'),
    student: await tok('student@demo.edu'),
    student2: await tok('student2@demo.edu'),
    admin: await tok('admin@demo.edu'),
  };
  globalThis.CID = cid;
});

after(async () => {
  server?.close();
  // 必须显式关连接池，否则 node --test 会一直挂着不退出
  if (driver && typeof driver.close === 'function') {
    try {
      await driver.close();
    } catch { /* 忽略关闭异常 */ }
  }
});

// ===================================================================== 测试
describe('认证与权限', () => {
  it('未登录访问被拒', async () => {
    const r = await get('/api/me');
    assert.equal(r.status, 401);
  });

  it('登录成功并返回 token', async () => {
    const r = await post('/api/auth/login', { email: 'teacher@demo.edu', password: 'demo1234' });
    assert.equal(r.status, 200);
    assert.ok(r.data.token);
    assert.equal(r.data.user.name, '张明');
  });

  it('密码错误被拒', async () => {
    const r = await post('/api/auth/login', { email: 'teacher@demo.edu', password: 'nope' });
    assert.equal(r.status, 400);
  });

  it('注册新学生', async () => {
    const r = await post('/api/auth/register', {
      email: 'new@demo.edu', name: '新同学', password: 'demo1234', role: 'student',
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.role, 'student');
  });

  it('重复邮箱被拒', async () => {
    const r = await post('/api/auth/register', {
      email: 'new@demo.edu', name: '重复', password: 'demo1234', role: 'student',
    });
    assert.equal(r.status, 400);
  });

  it('密码太短被拒', async () => {
    const r = await post('/api/auth/register', {
      email: 'short@demo.edu', name: '短', password: '123', role: 'student',
    });
    assert.equal(r.status, 400);
  });
});

describe('多教师隔离', () => {
  it('教师2 建课', async () => {
    const r = await post('/api/courses', { title: '王老师的课' }, { token: T.teacher2 });
    assert.equal(r.status, 200);
    globalThis.CID2 = r.data.id;
  });

  it('教师1 看不到教师2 的课', async () => {
    const r = await get('/api/courses', { token: T.teacher });
    const ids = r.data.teaching.map((c) => c.id);
    assert.ok(!ids.includes(CID2));
  });

  it('教师1 无法修改教师2 的课程', async () => {
    const r = await patch(`/api/courses/${CID2}/knowledge`, { title: 'x' }, { token: T.teacher });
    assert.ok([403, 404].includes(r.status));
  });
});

describe('课程与知识点', () => {
  it('教师可发布知识点', async () => {
    const r = await post(`/api/courses/${CID}/knowledge`,
      { title: 'UKF 无迹变换', content: '内容', scope: 'course' }, { token: T.teacher });
    assert.equal(r.status, 200);
    assert.equal(r.data.scope, 'course');
  });

  it('学生加知识点被强制为 private', async () => {
    const r = await post(`/api/courses/${CID}/knowledge`,
      { title: '我的笔记', content: 'x', scope: 'course' }, { token: T.student });
    assert.equal(r.status, 200);
    assert.equal(r.data.scope, 'private');
    globalThis.MY_KP = r.data.id;
  });

  it('其他学生看不到我的笔记', async () => {
    const r = await get(`/api/courses/${CID}`, { token: T.student2 });
    assert.equal(r.status, 403);   // 未选课
    await post('/api/courses/join', { join_code: 'DEMO01' }, { token: T.student2 });
    const r2 = await get(`/api/courses/${CID}`, { token: T.student2 });
    assert.ok(!r2.data.knowledge_points.some((k) => k.id === MY_KP));
  });

  it('教师能看到学生的笔记', async () => {
    const r = await get(`/api/courses/${CID}`, { token: T.teacher });
    assert.ok(r.data.knowledge_points.some((k) => k.id === MY_KP));
  });

  it('别人不能改/删我的笔记', async () => {
    assert.equal((await patch(`/api/knowledge/${MY_KP}`, { title: 'x' }, { token: T.student2 })).status, 403);
    assert.equal((await del(`/api/knowledge/${MY_KP}`, { token: T.student2 })).status, 403);
  });

  it('本人可以删自己的笔记', async () => {
    assert.equal((await del(`/api/knowledge/${MY_KP}`, { token: T.student })).status, 200);
  });

  it('「仅教师可见」的知识点学生看不到', async () => {
    const r = await post(`/api/courses/${CID}/knowledge`,
      { title: '内部资料', content: 'x', scope: 'teacher' }, { token: T.teacher });
    const kpId = r.data.id;
    const s = await get(`/api/courses/${CID}`, { token: T.student });
    assert.ok(!s.data.knowledge_points.some((k) => k.id === kpId));
    const t = await get(`/api/courses/${CID}`, { token: T.teacher });
    assert.ok(t.data.knowledge_points.some((k) => k.id === kpId));
  });

  it('学生不能上传资料', async () => {
    const r = await post(`/api/courses/${CID}/knowledge/extract`,
      { filename: 'a.md', content_base64: Buffer.from('# 标题\n内容内容内容').toString('base64') },
      { token: T.student });
    assert.equal(r.status, 403);
  });

  it('教师上传资料 → 启发式整理出知识点', async () => {
    const doc = '第一章 概述\n这是概述内容。\n\n第二章 方法\n这是方法内容。\n\n第三章 实验\n这是实验内容。';
    const r = await post(`/api/courses/${CID}/knowledge/extract`,
      { filename: 'ch.md', content_base64: Buffer.from(doc).toString('base64') }, { token: T.teacher });
    assert.equal(r.status, 200);
    assert.ok(r.data.points.length >= 3);
    globalThis.EXTRACTED = r.data.points;
  });

  it('确认入库为「仅教师可见」', async () => {
    const r = await post(`/api/courses/${CID}/knowledge/commit`,
      { source_file: 'ch.md', scope: 'teacher', points: EXTRACTED }, { token: T.teacher });
    assert.equal(r.status, 200);
    assert.equal(r.data.created, EXTRACTED.length);
  });

  it('不支持的文件类型被拒', async () => {
    const r = await post(`/api/courses/${CID}/knowledge/extract`,
      { filename: 'a.exe', content_base64: Buffer.from('MZ binary').toString('base64') }, { token: T.teacher });
    assert.equal(r.status, 400);
  });
});

describe('作业', () => {
  it('教师发布作业', async () => {
    const r = await post(`/api/courses/${CID}/assignments`,
      { title: '实验一', content: '做仿真', full_score: 100 }, { token: T.teacher });
    assert.equal(r.status, 200);
    globalThis.AID = r.data.id;
  });

  it('学生提交作业', async () => {
    const r = await post(`/api/assignments/${AID}/submit`, { content: '我的答案' }, { token: T.student });
    assert.equal(r.status, 200);
    globalThis.SID = r.data.id;
  });

  it('重复提交会更新而非新建', async () => {
    const r = await post(`/api/assignments/${AID}/submit`, { content: '更新后的答案' }, { token: T.student });
    assert.equal(r.data.id, SID);
  });

  it('教师评分', async () => {
    const r = await post(`/api/submissions/${SID}/grade`, { score: 88, feedback: '不错' }, { token: T.teacher });
    assert.equal(r.status, 200);
  });

  it('超满分评分被拒', async () => {
    const r = await post(`/api/submissions/${SID}/grade`, { score: 999 }, { token: T.teacher });
    assert.equal(r.status, 400);
  });

  it('学生能看到自己的作业页', async () => {
    const r = await get(`/api/assignments/${AID}`, { token: T.student });
    assert.equal(r.status, 200);
    assert.equal(r.data.my_submission.score, 88);
  });
});

describe('试题与答题', () => {
  const longOk =
    '本题考查卡尔曼增益的物理意义。正确选项 B 正确，因为增益在预测与观测之间做加权平衡；' +
    '选项 A 把增益误当成观测噪声方差，选项 C 混淆了状态转移矩阵，选项 D 把过程噪声谱密度与增益混为一谈。';

  it('缺解析的题被拒', async () => {
    const r = await post(`/api/courses/${CID}/quizzes`, {
      title: '缺解析', questions: [{ qtype: 'single', stem: 's', options: ['A. a', 'B. b'], answer: 'B', analysis: '' }],
    }, { token: T.teacher });
    assert.equal(r.status, 400);
  });

  it('教师建卷成功且答案/难度被规范化', async () => {
    const r = await post(`/api/courses/${CID}/quizzes`, {
      title: '第 1 章自测',
      questions: [
        { qtype: 'single', stem: '卡尔曼增益的作用是？', options: ['A. 观测噪声方差', 'B. 平衡预测与观测'], answer: 'b.', analysis: longOk, difficulty: '中等' },
        { qtype: 'judge', stem: 'Q 增大会使增益减小。', options: ['对', '错'], answer: '错误', analysis: longOk, difficulty: '简单' },
      ],
    }, { token: T.teacher });
    assert.equal(r.status, 200);
    globalThis.QID = r.data.id;

    const d = await get(`/api/quizzes/${QID}`, { token: T.teacher });
    assert.equal(d.data.questions[0].answer, 'B');
    assert.equal(d.data.questions[0].difficulty, 3);
    assert.equal(d.data.questions[1].answer, '错');
    assert.equal(d.data.questions[1].difficulty, 1);
  });

  it('学生取题时不下发答案与解析', async () => {
    const r = await get(`/api/quizzes/${QID}`, { token: T.student });
    assert.equal(r.status, 200);
    assert.ok(r.data.questions.every((q) => q.answer === undefined && q.analysis === undefined));
  });

  it('学生部分作答后交卷 → 小结区分未作答与答错', async () => {
    const qs = (await get(`/api/quizzes/${QID}`, { token: T.student })).data.questions;
    const r = await post(`/api/quizzes/${QID}/submit`, { answers: { [qs[0].id]: 'B' } }, { token: T.student });
    assert.equal(r.status, 200);
    const sm = r.data.summary;
    assert.equal(sm.total, 2);
    assert.equal(sm.answered_count, 1);
    assert.equal(sm.unanswered_count, 1);
    assert.equal(sm.wrong_count, 0);
    assert.equal(sm.correct_count, 1);
    assert.equal(sm.unanswered[0].no, 2);
    assert.deepEqual(sm.wrong, []);
  });

  it('review 里带正确答案与解析（供前端标绿）', async () => {
    const r = await post(`/api/quizzes/${QID}/submit`, { answers: {} }, { token: T.student });
    assert.ok(r.data.review.every((x) => x.answer && x.analysis));
    assert.ok(r.data.review.every((x) => Number.isInteger(x.difficulty)));
    assert.ok(r.data.review.every((x) => x.answered === false));
  });

  it('教师视角能看到答案解析与全班作答情况', async () => {
    const r = await get(`/api/quizzes/${QID}/overview`, { token: T.teacher });
    assert.equal(r.status, 200);
    assert.ok(r.data.quiz.questions.every((q) => q.analysis));
    assert.ok(r.data.stats.attempt_count >= 2);
    assert.ok(r.data.questions_stat[0].accuracy !== null);
    assert.ok(r.data.attempts.length >= 2);
  });

  it('学生无权看试题详情页', async () => {
    assert.equal((await get(`/api/quizzes/${QID}/overview`, { token: T.student })).status, 403);
  });

  it('教师可切换试卷可见性', async () => {
    assert.equal((await patch(`/api/quizzes/${QID}/scope`, { scope: 'teacher' }, { token: T.teacher })).status, 200);
    const s = await get(`/api/courses/${CID}`, { token: T.student });
    assert.ok(!s.data.quiz_sets.some((q) => q.id === QID));
    await patch(`/api/quizzes/${QID}/scope`, { scope: 'course' }, { token: T.teacher });
    const s2 = await get(`/api/courses/${CID}`, { token: T.student });
    assert.ok(s2.data.quiz_sets.some((q) => q.id === QID));
  });

  it('同一套题可以重复作答', async () => {
    const before = (await get('/api/my/attempts', { token: T.student })).data.attempts.length;
    await post(`/api/quizzes/${QID}/submit`, { answers: {} }, { token: T.student });
    const after = (await get('/api/my/attempts', { token: T.student })).data.attempts.length;
    assert.equal(after, before + 1);
  });

  it('历史记录页含 summary 与 quiz_id', async () => {
    const list = (await get('/api/my/attempts', { token: T.student })).data.attempts;
    const r = await get(`/api/attempts/${list[0].id}`, { token: T.student });
    assert.ok(r.data.summary);
    assert.equal(r.data.quiz_id, QID);
  });

  it('学生不能看别人的答题记录', async () => {
    const list = (await get('/api/my/attempts', { token: T.student })).data.attempts;
    assert.equal((await get(`/api/attempts/${list[0].id}`, { token: T.student2 })).status, 403);
  });

  it('薄弱知识点有统计', async () => {
    const r = await get(`/api/courses/${CID}/weak-points`, { token: T.student });
    assert.ok(r.data.weak_points.length >= 0);
  });
});

describe('AI 出题额度', () => {
  it('初始额度为 3 且未配置 key 时走离线模拟', async () => {
    const r = await get(`/api/courses/${CID}/ai-quota`, { token: T.student2 });
    assert.equal(r.data.limit, 3);
    assert.equal(r.data.used, 0);
    assert.equal(r.data.will_fallback_mock, true);
  });

  it('学生连出 3 套后第 4 次被拦', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await post('/api/ai/generate', { course_id: CID, count: 2 }, { token: T.student2 });
      assert.equal(r.status, 200);
      assert.equal(r.data.provider, 'mock');
    }
    const r = await post('/api/ai/generate', { course_id: CID, count: 2 }, { token: T.student2 });
    assert.equal(r.status, 429);
  });

  it('学生生成的题 scope=private 且别人看不到', async () => {
    const list = (await get(`/api/courses/${CID}`, { token: T.student2 })).data.quiz_sets;
    const mine = list.find((q) => q.source === 'ai');
    assert.ok(mine);
    assert.equal(mine.scope, 'private');
    const other = (await get(`/api/courses/${CID}`, { token: T.student })).data.quiz_sets;
    assert.ok(!other.some((q) => q.id === mine.id));
  });

  it('学生填自己的 Key 后解除限制', async () => {
    const r = await post('/api/me/ai-key', { provider: 'deepseek', api_key: 'sk-test-1234567890' }, { token: T.student2 });
    assert.equal(r.status, 200);
    assert.equal(r.data.unlimited, true);
    const me = await get('/api/me', { token: T.student2 });
    assert.equal(me.data.ai.key_masked, '••••••••7890');
    assert.ok(!JSON.stringify(me.data).includes('sk-test-1234567890'));
  });

  it('有自己 Key 后额度变为无限，且不计入每日额度', async () => {
    // 注意：此时 ai.source='own'，会真的去调 DeepSeek（无网络/假 key 必然失败），
    // 所以这里不去断言出题成功，而是断言额度规则本身 —— 这正是本用例要验证的点。
    const before = await get(`/api/courses/${CID}/ai-quota`, { token: T.student2 });
    assert.equal(before.data.unlimited, true);
    assert.equal(before.data.reason, 'own_key');
    assert.equal(before.data.limit, null);
    assert.equal(before.data.remaining, null);

    // 即便多次发起（失败不扣额度），used 也应该停在 3
    for (let i = 0; i < 2; i++) {
      await post('/api/ai/generate', { course_id: CID, count: 1 }, { token: T.student2 });
    }
    const after = await get(`/api/courses/${CID}/ai-quota`, { token: T.student2 });
    assert.equal(after.data.used, 3, '自带 key 不应计入每日额度');
    assert.equal(after.data.unlimited, true);
  });

  it('清除自己的 Key 后回到每日限额', async () => {
    const r = await post('/api/me/ai-key', { provider: 'deepseek', api_key: '' }, { token: T.student2 });
    assert.equal(r.status, 200);
    assert.equal(r.data.unlimited, false);
    assert.equal(r.data.limit, 3);
  });

  it('「解析不合格」的 AI 题会被丢弃', async () => {
    const { normalizeQuestions, analysisOk } = await import('../src/llm.js');
    const qs = normalizeQuestions([
      { qtype: 'single', stem: 's1', options: ['A. a', 'B. b'], answer: 'b.', analysis: '略', difficulty: '中等' },
    ]);
    assert.equal(qs[0].answer, 'B');
    assert.equal(qs[0].difficulty, 3);
    assert.equal(analysisOk(qs[0].analysis), false);
  });

  it('难度/答案规范化各种输入', async () => {
    const { normalizeDifficulty, canonicalAnswer } = await import('../src/llm.js');
    assert.equal(normalizeDifficulty('中等'), 3);
    assert.equal(normalizeDifficulty('简单'), 1);
    assert.equal(normalizeDifficulty('困难'), 4);
    assert.equal(normalizeDifficulty(null), 3);
    assert.equal(normalizeDifficulty('abc'), 3);
    assert.equal(normalizeDifficulty(9), 5);
    assert.equal(canonicalAnswer('c,a', 'multi'), 'AC');
    assert.equal(canonicalAnswer('正确', 'judge'), '对');
    assert.equal(canonicalAnswer('false', 'judge'), '错');
  });
});

describe('教师看板', () => {
  it('教师可看学情分析', async () => {
    const r = await get(`/api/courses/${CID}/analytics`, { token: T.teacher });
    assert.equal(r.status, 200);
    assert.ok(r.data.students.length >= 1);
    assert.ok(Array.isArray(r.data.weak_knowledge_points));
    assert.ok(Array.isArray(r.data.trend));
  });

  it('学生无权看学情分析', async () => {
    assert.equal((await get(`/api/courses/${CID}/analytics`, { token: T.student })).status, 403);
  });

  it('教师可看学生名单', async () => {
    const r = await get(`/api/courses/${CID}/students`, { token: T.teacher });
    assert.equal(r.status, 200);
    assert.ok(r.data.students.length >= 1);
  });
});

describe('管理员', () => {
  it('平台 Key 初始未配置', async () => {
    const r = await get('/api/admin/platform-ai', { token: T.admin });
    assert.equal(r.status, 200);
    assert.equal(r.data.configured, false);
    assert.equal(r.data.daily_limit, 3);
  });

  it('普通教师不能看平台配置', async () => {
    assert.equal((await get('/api/admin/platform-ai', { token: T.teacher })).status, 403);
  });

  it('管理员上传平台 Key（脱敏回显）', async () => {
    const r = await post('/api/admin/platform-ai', {
      provider: 'deepseek', api_key: 'sk-platform-secret-ABCD',
      base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
      enabled: true, daily_limit: 5,
    }, { token: T.admin });
    assert.equal(r.status, 200);
    assert.equal(r.data.configured, true);
    assert.equal(r.data.key_masked, '••••••••ABCD');
    assert.equal(r.data.daily_limit, 5);
    assert.ok(!JSON.stringify(r.data).includes('sk-platform-secret-ABCD'));
  });

  it('平台配置对所有人生效（额度跟随）', async () => {
    const p = await get('/api/ai/providers');
    assert.equal(p.data.platform_key_configured, true);
    assert.equal(p.data.daily_limit, 5);
    const q = await get(`/api/courses/${CID}/ai-quota`, { token: T.student });
    assert.equal(q.data.limit, 5);
    assert.equal(q.data.will_fallback_mock, false);
  });

  it('管理员用平台 Key 不受限', async () => {
    const q = await get(`/api/courses/${CID}/ai-quota`, { token: T.admin });
    assert.equal(q.data.unlimited, true);
    assert.equal(q.data.reason, 'admin');
  });

  it('管理员可停用 / 清除平台 Key', async () => {
    assert.equal((await post('/api/admin/platform-ai', { enabled: false }, { token: T.admin })).data.enabled, false);
    const p = await get('/api/ai/providers');
    assert.equal(p.data.platform_key_configured, false);
    assert.equal((await post('/api/admin/platform-ai', { api_key: '', clear_key: true }, { token: T.admin })).data.configured, false);
  });

  it('管理员可管理用户（改角色/停用/删除）', async () => {
    assert.equal((await patch(`/api/admin/users/${student2}`, { is_admin: true }, { token: T.admin })).status, 200);
    assert.equal((await patch(`/api/admin/users/${student2}`, { is_admin: false }, { token: T.admin })).status, 200);
    assert.equal((await patch(`/api/admin/users/${student2}`, { is_active: false }, { token: T.admin })).status, 200);
    const login = await post('/api/auth/login', { email: 'student2@demo.edu', password: 'demo1234' });
    assert.equal(login.status, 403);          // 已停用
    await patch(`/api/admin/users/${student2}`, { is_active: true }, { token: T.admin });
  });

  it('管理员不能取消/删除自己', async () => {
    assert.equal((await patch(`/api/admin/users/${admin}`, { is_admin: false }, { token: T.admin })).status, 400);
    assert.equal((await del(`/api/admin/users/${admin}`, { token: T.admin })).status, 400);
  });

  it('管理员可看全局统计与课程列表', async () => {
    const s = await get('/api/admin/stats', { token: T.admin });
    assert.equal(s.status, 200);
    assert.ok(s.data.users >= 5);
    assert.ok(s.data.courses >= 1);
    const c = await get('/api/admin/courses', { token: T.admin });
    assert.ok(c.data.courses.length >= 2);
  });

  it('管理员可删除任意课程', async () => {
    assert.equal((await del(`/api/admin/courses/${CID2}`, { token: T.admin })).status, 200);
    assert.equal((await get(`/api/courses/${CID2}`, { token: T.teacher2 })).status, 404);
  });
});

describe('接口边界与 CORS（前后端分离）', () => {
  it('未知 API 返回 JSON 404', async () => {
    const r = await get('/api/definitely-not-here');
    assert.equal(r.status, 404);
    assert.ok(r.data.detail);
  });

  it('后端不托管静态资源：首页与前端资源一律 404', async () => {
    for (const p of ['/', '/app.js', '/app.css', '/course/1']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 404, `${p} 由 frontend/ 托管，后端不该响应`);
      assert.ok((await res.json()).detail, `${p} 应返回 JSON 404 而不是 HTML`);
    }
  });

  it('预检请求返回 204，并下发白名单来源与允许的方法/头', async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'OPTIONS',
      headers: {
        Origin: FRONTEND_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('access-control-allow-headers').toLowerCase(), /authorization/);
  });

  it('白名单外的来源不下发跨源头', async () => {
    const res = await fetch(base + '/api/me', { headers: { Origin: 'http://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('失败响应（401）也带回跨源头，避免前端只看到 Failed to fetch', async () => {
    const res = await fetch(base + '/api/me', { headers: { Origin: FRONTEND_ORIGIN } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);
    assert.equal(res.headers.get('vary'), 'Origin');
  });
});
