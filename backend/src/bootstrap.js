/**
 * 公共装配：数据库（MySQL）+ 环境 + 应用实例
 *
 * server.js（启动服务）与 test/api.test.js（测试）都用它，
 * 保证「怎么跑服务」和「怎么跑测试」是同一套装配。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { Db } from './db.js';
import { connectFromEnv } from './drivers.js';
import { hashPassword } from './security.js';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 建表脚本路径（MySQL 是唯一事实来源） */
export const SCHEMA_FILE = path.join(ROOT, 'migrations', 'mysql', '0001_schema.sql');

export function readSchemaSql() {
  return fs.readFileSync(SCHEMA_FILE, 'utf8');
}

/**
 * 连接 MySQL，可选执行建表脚本
 *
 * @param {object} opts
 * @param {object} [opts.env]      环境变量（取 LEARNHUB_DB_URL）
 * @param {object} [opts.driver]   直接传入已建好的驱动（测试复用连接池）
 * @param {boolean} [opts.schema]  是否执行建表脚本（幂等，可重复跑）
 */
export async function initDatabase({ env = process.env, driver = null, schema = false } = {}) {
  const drv = driver || await connectFromEnv(env);
  const db = new Db(drv);
  let statements = 0;
  if (schema) statements = await db.execScript(readSchemaSql());
  return { driver: drv, db, statements };
}

const KPS = [
  ['卡尔曼滤波的基本思想',
    '卡尔曼滤波是一种递推的最小方差估计方法。它把系统建模为状态方程与观测方程，' +
    '在每个时刻交替执行「预测」与「更新」两步：\n\n' +
    '- 预测：用状态转移矩阵 F 外推状态与协方差\n' +
    '- 更新：用卡尔曼增益 K 融合观测，修正估计\n\n' +
    '核心公式：K = P⁻Hᵀ(HP⁻Hᵀ+R)⁻¹。卡尔曼增益本质上是在「相信预测」和「相信观测」之间做加权平衡：' +
    '预测协方差大就多信观测，观测噪声大就多信预测。\n\n' +
    '适用前提：系统线性、噪声为互不相关的高斯白噪声。'],
  ['扩展卡尔曼滤波（EKF）',
    '当状态方程或观测方程非线性时，EKF 通过一阶泰勒展开在工作点附近做线性化：\n\n' +
    '- 用雅可比矩阵 F_k = ∂f/∂x 代替线性系统的状态转移矩阵\n' +
    '- 用雅可比矩阵 H_k = ∂h/∂x 代替观测矩阵\n\n' +
    'EKF 的优点是计算量小；缺点是：\n' +
    '1. 一阶线性化在强非线性下误差大，甚至发散；\n' +
    '2. 雅可比矩阵需要解析求导，模型复杂时推导困难；\n' +
    '3. 线性化点偏离真值较远时估计精度明显下降。'],
  ['无迹卡尔曼滤波（UKF）与无迹变换',
    'UKF 不使用线性化，而是用「无迹变换（UT）」处理非线性：\n\n' +
    '1. 按确定性规则在均值周围选取 2n+1 个 Sigma 点；\n' +
    '2. 将 Sigma 点直接代入非线性函数传播；\n' +
    '3. 用传播后点集的加权均值与协方差近似后验分布。\n\n' +
    '关键参数：λ = α²(n+κ) − n，α 决定 Sigma 点的散布范围（常取 1e-3 ~ 1）。\n\n' +
    'UKF 能达到二阶以上精度，且无需计算雅可比矩阵，在强非线性场景下优于 EKF。'],
  ['多传感器加权融合准则',
    '对 L 个传感器的局部估计 x̂ᵢ（方差 Pᵢ），在最小均方误差准则下，线性加权融合估计为：\n\n' +
    'x̂ = Σ Wᵢ x̂ᵢ， 其中权重 Wᵢ = Pᵢ⁻¹ / Σ Pⱼ⁻¹\n\n结论：\n' +
    '1. 方差越小的传感器权重越大，符合直觉；\n' +
    '2. 融合后方差 P = (Σ Pᵢ⁻¹)⁻¹，恒小于任一局部方差；\n' +
    '3. 若各传感器噪声相关，最优权重需用互协方差矩阵修正，经典标量权重公式不再最优。'],
];

const LONG_OK =
  '本题考查卡尔曼增益的物理意义。正确选项 B 正确，因为增益 K = P⁻Hᵀ(HP⁻Hᵀ+R)⁻¹ 在预测与观测之间做加权平衡：' +
  '预测不确定就多信观测，观测噪声大就多信预测。选项 A 把增益误当成观测噪声的方差；' +
  '选项 C 混淆了状态转移矩阵的作用；选项 D 则把过程噪声谱密度与增益混为一谈。';
const JUDGE_OK =
  '该说法错误。Q 增大意味着更不信任预测模型，预测协方差 P⁻ 变大，卡尔曼增益随之增大（而非减小），' +
  '从而更多采纳观测值。判断这类题要抓住「谁变大→谁被更信任→增益往哪边移」这条因果链。';

/** 写入演示数据（已存在则跳过） */
export async function seedDemoData(db) {
  const exists = await db.first('SELECT 1 AS ok FROM users LIMIT 1');
  if (exists) return false;

  const pw = await hashPassword('demo1234');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const mk = (email, name, role, isAdmin, studentNo) => db.run(
    `INSERT INTO users (email,name,role,is_admin,password_hash,school,student_no,is_active,created_at)
     VALUES (?,?,?,?,?,?,?,1,?)`,
    email, name, role, isAdmin, pw, '山西农业大学软件学院', studentNo, now);

  const t = await mk('teacher@demo.edu', '张明', 'teacher', 0, null);
  const s = await mk('student@demo.edu', '李小凡', 'student', 0, '2026S001');
  await mk('admin@demo.edu', '平台管理员', 'teacher', 1, null);

  const course = await db.run(
    `INSERT INTO courses (title,description,cover_emoji,join_code,teacher_id,is_published,created_at)
     VALUES (?,?,?,?,?,1,?)`,
    '多传感器信息融合滤波技术',
    '卡尔曼滤波 / EKF / UKF 与多传感器加权融合，含状态估计方差对比实验。',
    '🛰️', 'DEMO01', t.lastRowId, now);
  const cid = course.lastRowId;

  await db.run('INSERT INTO enrollments (course_id,student_id,created_at) VALUES (?,?,?)', cid, s.lastRowId, now);
  await db.run('INSERT INTO announcements (course_id,content,created_at) VALUES (?,?,?)', cid,
    '本周重点：UKF 的无迹变换与 Sigma 点选取，请完成课后作业并做一遍知识点自测。', now);

  const kpIds = [];
  for (let i = 0; i < KPS.length; i++) {
    const r = await db.run(
      `INSERT INTO knowledge_points (course_id,title,content,order_no,scope,created_by,created_at)
       VALUES (?,?,?,?,?,?,?)`,
      cid, KPS[i][0], KPS[i][1], i, 'course', t.lastRowId, now);
    kpIds.push(r.lastRowId);
  }

  await db.run(
    `INSERT INTO assignments (course_id,title,content,due_at,full_score,created_at)
     VALUES (?,?,?,?,?,?)`,
    cid, '实验一：卡尔曼滤波状态估计方差对比',
    '用 MATLAB 或 Python 复现课件中的仿真：\n1. 建立线性系统模型，生成三路传感器观测；\n' +
    '2. 分别给出三路传感器的状态估计方差曲线；\n3. 与融合后的方差曲线对比，说明融合带来的精度提升。\n\n' +
    '提交内容：代码 + 方差对比图 + 不超过 500 字的结论分析。',
    new Date(Date.now() + 7 * 864e5).toISOString().replace('T', ' ').slice(0, 19), 100, now);

  const quiz = await db.run(
    `INSERT INTO quiz_sets (course_id,title,source,scope,kp_ids,created_by,is_published,created_at)
     VALUES (?,?,?,?,?,?,1,?)`,
    cid, '第 1 章 · 卡尔曼滤波基础自测', 'manual', 'course',
    JSON.stringify([kpIds[0]]), t.lastRowId, now);

  const QS = [
    ['single', '卡尔曼滤波的卡尔曼增益 K 的物理含义是：',
      ['A. 观测噪声的方差', 'B. 在预测与观测之间做加权平衡的系数', 'C. 状态转移矩阵的逆',
        'D. 系统过程噪声的功率谱密度'], 'B', LONG_OK, 2],
    ['judge', '当过程噪声方差 Q 增大时，卡尔曼增益会相应减小。', ['对', '错'], '错', JUDGE_OK, 2],
    ['multi', '卡尔曼滤波的适用前提包括：',
      ['A. 系统为线性系统', 'B. 过程噪声与观测噪声为高斯白噪声', 'C. 噪声之间互不相关',
        'D. 系统必须是时不变的'], 'ABC',
      '经典卡尔曼滤波要求线性系统、高斯白噪声且互不相关，但并不要求时不变——时变系统同样可以逐步递推。' +
      '故 D 错误，选 ABC。', 3],
    ['single', '融合前后状态估计方差的关系是：',
      ['A. 融合后方差等于各传感器方差的算术平均', 'B. 融合后方差大于最小单传感器方差',
        'C. 融合后方差小于任一单传感器方差', 'D. 二者没有确定关系'], 'C',
      '按最小均方误差准则，P = (Σ Pᵢ⁻¹)⁻¹，即各传感器信息量（方差倒数）之和的倒数，' +
      '必然小于任何一个单独的 Pᵢ。这正是多传感器融合提升精度的理论依据。故选 C。', 3],
  ];
  for (let i = 0; i < QS.length; i++) {
    const [qtype, stem, options, answer, analysis, difficulty] = QS[i];
    await db.run(
      `INSERT INTO questions (quiz_set_id,qtype,stem,options,answer,analysis,difficulty,kp_id,order_no)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      quiz.lastRowId, qtype, stem, JSON.stringify(options), answer, analysis, difficulty, kpIds[0], i);
  }
  return true;
}

/** 组装好的应用 + 数据库（启动服务与测试共用） */
export async function bootstrap({
  env = process.env, seed = true, driver = null, schema = false,
} = {}) {
  const { driver: drv, db, statements } = await initDatabase({ env, driver, schema });
  if (seed) await seedDemoData(db);
  const baseEnv = {
    LEARNHUB_SECRET: 'dev-only-change-me-in-production',
    LEARNHUB_DEFAULT_PROVIDER: 'deepseek',
    LEARNHUB_PLATFORM_API_KEY: '',
    LEARNHUB_DAILY_AI_LIMIT: '3',
    LEARNHUB_CORS_ORIGIN: '*',
    ...env,
  };
  const app = createApp({ db, env: baseEnv });
  return { app, db, driver: drv, env: baseEnv, statements };
}
