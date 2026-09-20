/**
 * AI 层 —— 统一走 OpenAI 兼容的 /chat/completions
 *
 * 支持：DeepSeek（默认）/ OpenAI / 通义千问 / 智谱 GLM / Kimi / 自定义兼容端点
 * 没有配置任何 key 时降级为 MockProvider（离线模板题），保证流程可演示。
 *
 * Workers 里用全局 fetch 即可，不需要 axios/undici。
 */

export const PROVIDERS = {
  deepseek: { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  dashscope: {
    label: '通义千问',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  zhipu: { label: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  moonshot: { label: 'Kimi', base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  custom: { label: '自定义 OpenAI 兼容接口', base_url: '', model: '' },
};

export const DEFAULT_PROVIDER = 'deepseek';

/** 解析低于这个长度视为「解析不合格」 */
export const ANALYSIS_MIN_LEN = 30;

export class LlmError extends Error {}

// ------------------------------------------------------------------ Prompt
const SYSTEM_PROMPT = `你是一位严谨的高校课程命题老师。请根据给定的课程知识点命制试题。
要求：
1. 只考查给定知识点范围内的内容，不超纲；
2. 题干表述清晰、无歧义，选择题的干扰项要合理；
3. 严格输出 JSON，不要输出任何解释性文字或 Markdown 代码块标记；
4. difficulty 必须是 1~5 的整数（1 最容易，5 最难），不要写"中等""简单"等文字。

【解析（analysis）是硬性要求，必须详细，不达标视为无效题目】
- 必须说明正确选项为什么正确：给出依据的定义、公式或推理过程；
- 必须指出错误选项分别错在哪里（至少覆盖主要干扰项）；
- 建议不少于 60 字，绝对不能只写"略""同上""见教材""因为 A 对"这类空话；
- 判断题也要写清判断依据（哪个条件不满足、哪个概念被偷换）。

JSON 结构：
{"questions":[{"qtype":"single|multi|judge","stem":"题干","options":["A. ...","B. ...","C. ...","D. ..."],"answer":"A","analysis":"详细解析","difficulty":1-5}]}
说明：判断题 options 固定为 ["对","错"]，answer 填 "对" 或 "错"；多选题 answer 形如 "AB"。`;

const DIFFICULTY_WORDS = {
  很容易: 1, 极简单: 1, 简单: 1, 容易: 2, 基础: 2, 较易: 2, easy: 2,
  中等: 3, 一般: 3, 适中: 3, medium: 3, normal: 3,
  较难: 4, 偏难: 4, 困难: 4, hard: 4, 很难: 5, 极难: 5,
};

function buildUserPrompt({ kpTitles, kpContents, count, qtype, difficulty, extra, retryHint }) {
  const typeCn = {
    single: '单项选择题', multi: '多项选择题', judge: '判断题', mixed: '混合题型',
  }[qtype] || '单项选择题';
  const diffCn = {
    easy: '偏基础', medium: '中等', hard: '偏难', mixed: '难度适中、有梯度',
  }[difficulty] || '中等';
  const kpBlock = kpTitles
    .map((t, i) => `【知识点 ${i + 1}】${t}\n${(kpContents[i] || '').slice(0, 1200)}`)
    .join('\n\n');
  return `请命制 ${count} 道${typeCn}，难度${diffCn}。
${extra ? '补充要求：' + extra : ''}
${retryHint || ''}

可考查的知识点如下：
${kpBlock}`;
}

// ------------------------------------------------------------------ 解析与规范化
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch { /* 继续尝试抽取 */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (e) {
      throw new LlmError(`AI 返回内容不是合法 JSON：${e.message}`);
    }
  }
  throw new LlmError('AI 返回内容里找不到 JSON');
}

/** 把难度统一成 1~5 的整数，前端永远不会出现 undefined */
export function normalizeDifficulty(value, fallback = 3) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return fallback;
  const num = Number(value);
  if (Number.isFinite(num)) return Math.max(1, Math.min(5, Math.round(num)));
  const text = String(value).trim().toLowerCase();
  for (const word of Object.keys(DIFFICULTY_WORDS).sort((a, b) => b.length - a.length)) {
    if (text.includes(word)) return DIFFICULTY_WORDS[word];
  }
  const m = text.match(/[1-5]/);
  return m ? Number(m[0]) : fallback;
}

/** 把答案统一成规范形式，保证"正确选项标绿"一定匹配得上 */
export function canonicalAnswer(value, qtype) {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';

  if (qtype === 'judge') {
    const t = raw.toLowerCase();
    if (['对', '√', '正确', '是', 'true', 't', 'yes', 'y', 'right', 'correct', '1'].includes(t)) return '对';
    if (['错', '×', '错误', '否', 'false', 'f', 'no', 'n', 'wrong', 'incorrect', '0'].includes(t)) return '错';
    if (raw.includes('对') || raw.includes('正确')) return '对';
    if (raw.includes('错') || raw.includes('错误')) return '错';
    return raw.slice(0, 1);
  }
  if (qtype === 'short') return raw;

  const letters = raw.toUpperCase().match(/[A-Z]/g);
  if (letters && letters.length) {
    const uniq = [...new Set(letters)].sort();
    return qtype === 'single' && uniq.length > 1 ? uniq[0] : uniq.join('');
  }
  return raw;
}

export function analysisOk(analysis) {
  const t = String(analysis || '').trim();
  if (t.length < ANALYSIS_MIN_LEN) return false;
  return !['略', '同上', '见教材', '无', '略述', '解析', '暂无'].includes(t);
}

/** 把 AI 原始题目规整成内部结构（选项数组、规范答案、整数难度） */
export function normalizeQuestions(rawList) {
  const out = [];
  for (const q of Array.isArray(rawList) ? rawList : []) {
    if (!q || typeof q !== 'object') continue;
    const stem = String(q.stem || q.question || '').trim();
    if (!stem) continue;
    let qtype = String(q.qtype || q.type || 'single').toLowerCase();
    if (!['single', 'multi', 'judge', 'short'].includes(qtype)) qtype = 'single';

    let options = q.options;
    if (qtype === 'judge' && !options) options = ['对', '错'];
    if (typeof options === 'string') options = options.split('|').map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(options)) {
      options = options.map((o) => String(o).trim()).filter(Boolean);
      if (qtype === 'judge' && options.length !== 2) options = ['对', '错'];
    } else {
      options = null;
    }

    out.push({
      qtype,
      stem,
      options,
      answer: canonicalAnswer(q.answer, qtype),
      analysis: String(q.analysis || q.explanation || '').trim(),
      difficulty: normalizeDifficulty(q.difficulty),
    });
  }
  return out;
}

// ------------------------------------------------------------------ 调用
async function callOpenAiCompatible({ baseUrl, apiKey, model, system, user, timeoutMs = 90000 }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new LlmError(`无法连接 AI 服务（${baseUrl}）：${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401) throw new LlmError('API Key 无效或已过期（HTTP 401）');
  if (resp.status === 402) throw new LlmError('API 账户余额不足（HTTP 402）');
  if (resp.status === 429) throw new LlmError('AI 服务限流，请稍后重试（HTTP 429）');
  if (resp.status >= 400) {
    const text = await resp.text().catch(() => '');
    throw new LlmError(`AI 服务返回错误 HTTP ${resp.status}：${text.slice(0, 300)}`);
  }

  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new LlmError('无法解析 AI 响应');
  return content;
}

// ------------------------------------------------------------------ Mock（离线）
export class MockProvider {
  static SINGLE_TPL = [
    ['关于「{kp}」，下列说法正确的是：',
      ['符合教材描述的表述', '与定义相反的表述', '把概念张冠李戴的表述', '过度绝对化的表述'], 'A'],
    ['下列关于「{kp}」的叙述中，错误的是：',
      ['与基本定义一致的说法', '混淆了相近概念的说法', '遗漏关键前提的说法', '扩大了适用范围的说法'], 'B'],
  ];

  generate(kpTitles, kpContents, count, qtype) {
    const items = [];
    const titles = kpTitles.length ? kpTitles : ['本课程知识点'];
    for (let i = 0; i < count; i++) {
      const kp = titles[i % titles.length];
      const snippet = (kpContents[i % kpContents.length] || '').slice(0, 120).replace(/\n/g, ' ');
      if (qtype === 'judge' || (qtype === 'mixed' && i % 3 === 2)) {
        items.push({
          qtype: 'judge',
          options: ['对', '错'],
          answer: i % 2 === 0 ? '错' : '对',
          stem: `判断：${kp} 的核心结论在任意条件下都严格成立。`,
          analysis:
            `【模拟题·离线模式】本题考查「${kp}」的适用前提。结论本身是正确的，但它成立需要满足特定条件` +
            `（例如模型线性、噪声为互不相关的高斯白噪声等），一旦前提被破坏，结论就不再保证成立。` +
            `题干用了「在任意条件下」「严格成立」这类绝对化表述，因此判断为「错」。` +
            `做判断题的关键是先找出结论的前提条件，再看题目有没有把它去掉或扩大。参考原文：${snippet}`,
          difficulty: 2,
        });
      } else {
        const [tpl, opts, ans] = MockProvider.SINGLE_TPL[i % MockProvider.SINGLE_TPL.length];
        const correctText = opts['ABCD'.indexOf(ans)];
        items.push({
          qtype: 'single',
          options: opts.map((o, k) => `${'ABCD'[k]}. ${o}`),
          answer: ans,
          stem: tpl.replace('{kp}', kp),
          analysis:
            `【模拟题·离线模式】本题考查「${kp}」。正确选项 ${ans}（${correctText}）与知识点的定义/结论完全一致，` +
            `是在给定前提下的标准表述。其余选项之所以错误：有的把定义反向表述，有的偷换概念` +
            `（用相近但不同的名词替代关键词），还有的以偏概全或过度绝对化。` +
            `判断这类题的方法：逐项回到知识点原文核对关键词、条件与取值范围。参考原文：${snippet}`,
          difficulty: 3,
        });
      }
    }
    return items;
  }
}

// ------------------------------------------------------------------ 对外入口
/**
 * 出题。apiKey 为空时走离线 Mock。
 * 返回 { questions, provider, dropped }，dropped 是因解析不合格被丢弃的题数。
 */
export async function generateQuestions({
  provider, apiKey, baseUrl, model,
  kpTitles, kpContents, count, qtype, difficulty, extra = '',
}) {
  const limit = Math.max(1, Math.min(Number(count) || 5, 20));

  if (!apiKey) {
    return { questions: new MockProvider().generate(kpTitles, kpContents, limit, qtype), provider: 'mock', dropped: 0 };
  }

  const cfg = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
  const url = (baseUrl || cfg.base_url || '').trim();
  const mdl = (model || cfg.model || '').trim();
  if (!url || !mdl) throw new LlmError('自定义服务商需要同时填写 Base URL 和模型名');

  const raw = await callOpenAiCompatible({
    baseUrl: url, apiKey, model: mdl, system: SYSTEM_PROMPT,
    user: buildUserPrompt({ kpTitles, kpContents, count: limit, qtype, difficulty, extra }),
  });
  const data = extractJson(raw);
  let questions = normalizeQuestions(data.questions || []);
  if (!questions.length) throw new LlmError('AI 没有生成有效题目，请重试或调整知识点内容');

  // 解析不合格的：先请 AI 补写，补不出来就丢弃
  const bad = questions.filter((q) => !analysisOk(q.analysis));
  let dropped = 0;
  if (bad.length) {
    const fixed = await fillMissingAnalysis({ url, apiKey, model: mdl, items: bad }).catch(() => []);
    const kept = questions.filter((q) => analysisOk(q.analysis));
    const good = fixed.filter((q) => analysisOk(q.analysis));
    dropped = bad.length - good.length;
    questions = [...kept, ...good];
    if (!questions.length) {
      throw new LlmError('AI 生成的题目缺少解析，请重试（可在补充要求里强调「必须给出详细解析」）');
    }
  }
  return { questions, provider, dropped };
}

async function fillMissingAnalysis({ url, apiKey, model, items }) {
  const payload = items.map((q) => ({
    stem: q.stem, options: q.options, answer: q.answer, qtype: q.qtype,
  }));
  const prompt =
    '下面这些题目缺少合格解析。请为每一题补写**详细解析**（≥60 字，说明正确项为什么对、' +
    '错误项错在哪），保持题目与答案不变。\n' +
    '严格输出 JSON：{"questions":[{"analysis":"..."}]}，顺序与输入一致。\n\n' +
    JSON.stringify(payload);
  const raw = await callOpenAiCompatible({ baseUrl: url, apiKey, model, system: SYSTEM_PROMPT, user: prompt });
  const data = extractJson(raw);
  const fixes = (data.questions || []).map((x) => String(x?.analysis || '').trim());
  return items
    .map((q, i) => (analysisOk(fixes[i]) ? { ...q, analysis: fixes[i] } : null))
    .filter(Boolean);
}

/** 资料正文 → 知识点列表。未配 key 时按标题/段落启发式切分 */
const EXTRACT_SYSTEM = `你是一位课程助教。请把老师上传的课程资料整理成结构化的知识点列表。
要求：
1. 按内容逻辑切分成若干个独立知识点，每个知识点自成一个完整主题；
2. title 简洁（不超过 25 字），content 保留关键定义、公式、结论与要点，可适当润色但不得编造；
3. 覆盖资料中的全部主要内容，不要遗漏，也不要重复；
4. 严格输出 JSON，不要输出任何解释文字或 Markdown 代码块标记。

JSON 结构：
{"points":[{"title":"知识点标题","content":"该知识点的完整内容，可含换行"}]}`;

export async function extractKnowledgePoints({
  provider, apiKey, baseUrl, model, text, courseTitle = '', maxPoints = 20,
}) {
  const body = String(text || '').trim();
  if (!body) throw new LlmError('文件内容为空，或该格式无法解析出文字');

  if (!apiKey) return { points: heuristicSplit(body, maxPoints), provider: 'mock' };

  const cfg = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
  const url = (baseUrl || cfg.base_url || '').trim();
  const mdl = (model || cfg.model || '').trim();
  if (!url || !mdl) throw new LlmError('自定义服务商需要同时填写 Base URL 和模型名');

  const userPrompt =
    `课程名称：${courseTitle || '（未提供）'}\n` +
    `请把下面的资料整理成不超过 ${maxPoints} 个知识点：\n\n` +
    `---- 资料开始 ----\n${body.slice(0, 20000)}\n---- 资料结束 ----`;
  const raw = await callOpenAiCompatible({
    baseUrl: url, apiKey, model: mdl, system: EXTRACT_SYSTEM, user: userPrompt, timeoutMs: 150000,
  });
  const data = extractJson(raw);
  const points = (data.points || [])
    .map((p) => ({
      title: String(p?.title || '').trim().slice(0, 200),
      content: String(p?.content || p?.detail || '').trim(),
    }))
    .filter((p) => p.title);
  if (!points.length) throw new LlmError('AI 没有从资料中识别出知识点，请换一份内容更完整的文件');
  return { points: points.slice(0, maxPoints), provider };
}

function heuristicSplit(text, maxPoints) {
  const headRe = /^\s*(#{1,4}\s+.+|第[一二三四五六七八九十百\d]+[章节讲部分].*|[一二三四五六七八九十]+[、.．].*|\d+[、.．)]\s*.+)\s*$/;
  const blocks = [];
  let curTitle = null;
  let curBody = [];
  for (const line of text.split('\n')) {
    if (headRe.test(line) && line.trim().length <= 60) {
      if (curTitle) blocks.push([curTitle, curBody]);
      curTitle = line.replace(/^\s*#{1,4}\s*/, '').trim();
      curBody = [];
    } else {
      curBody.push(line);
    }
  }
  if (curTitle) blocks.push([curTitle, curBody]);

  if (!blocks.length) {
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (!paras.length) return [{ title: '上传资料要点', content: text.slice(0, 4000) }];
    const per = Math.max(1, Math.floor(paras.length / Math.min(maxPoints, 8)) + 1);
    for (let i = 0; i < Math.min(paras.length, maxPoints * per); i += per) {
      blocks.push([paras[i].slice(0, 24) || `要点 ${i / per + 1}`, paras.slice(i, i + per)]);
    }
  }

  const points = blocks.slice(0, maxPoints).map(([t, b]) => ({
    title: t.slice(0, 200),
    content: b.join('\n').trim() || '（原文无正文，请手动补充）',
  }));
  return points.length ? points : [{ title: '上传资料要点', content: text.slice(0, 4000) }];
}
