#!/usr/bin/env node
/**
 * LearnHub 后端启动入口 —— 只有这一种方式：本地 Node + MySQL
 *
 *   node server.js        （等价于 npm start / npm run dev）
 *
 * 配置来自环境变量（可写进 backend/.env，见 .env.example）：
 *   LEARNHUB_DB_URL=mysql://user:pass@127.0.0.1:3306/learnhub   ← 必填
 *
 * 启动行为：
 *   · 幂等执行建表脚本（LEARNHUB_AUTO_MIGRATE=0 可关闭）
 *   · 空库自动灌一套演示数据（LEARNHUB_SEED=0 可关闭）
 *
 * 说明：本服务只对外提供 /api/*，静态资源由 frontend/ 独立托管。
 */
import { bootstrap, readSchemaSql } from './src/bootstrap.js';
import { createMysqlDriver, parseMysqlUrl } from './src/drivers.js';
import { createNodeServer } from './src/node-adapter.js';
import { DEFAULT_SECRET } from './src/config.js';

const PORT = Number(process.env.PORT || 8899);
const HOST = process.env.HOST || '127.0.0.1';
const url = String(process.env.LEARNHUB_DB_URL || '').trim();
const autoMigrate = String(process.env.LEARNHUB_AUTO_MIGRATE ?? '1') !== '0';
const seedDemo = String(process.env.LEARNHUB_SEED ?? '1') !== '0';

if (!url) {
  console.error('❌ 缺少 LEARNHUB_DB_URL。请在 backend/.env 中配置，例如：');
  console.error('   LEARNHUB_DB_URL=mysql://root:你的密码@127.0.0.1:3306/learnhub');
  console.error('   可复制 .env.example 作为模板。');
  process.exit(1);
}

const cfg = parseMysqlUrl(url);
console.log(`[db] 目标 MySQL：${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

let driver;
try {
  driver = await createMysqlDriver(cfg);
} catch (err) {
  if (err?.code === 'ER_BAD_DB_ERROR') {
    console.error(`❌ 数据库 ${cfg.database} 不存在。先执行：npm run db:create`);
  } else if (err?.code === 'ER_ACCESS_DENIED_ERROR') {
    console.error('❌ 账号或密码被拒。检查 LEARNHUB_DB_URL 里的用户名与密码。');
  } else {
    console.error(`❌ 连接 MySQL 失败：${err.message}`);
  }
  process.exit(1);
}
console.log('[db] 已连接');

if (autoMigrate) {
  const count = await driver.execScript(readSchemaSql());
  console.log(`[db] 建表脚本已执行（${count} 条语句，幂等）`);
} else {
  console.log('[db] 已跳过建表（LEARNHUB_AUTO_MIGRATE=0），请确认表已由 npm run db:migrate 建立');
}

const { app, env, db } = await bootstrap({ env: process.env, driver, seed: seedDemo });

if (seedDemo) {
  const hasUsers = await db.first('SELECT 1 AS ok FROM users LIMIT 1');
  console.log(hasUsers ? '[seed] 已有数据，跳过演示数据' : '[seed] 已写入演示数据');
}

if (env.LEARNHUB_SECRET === DEFAULT_SECRET) {
  console.warn('⚠️  LEARNHUB_SECRET 仍是默认值：任何人都能伪造登录令牌、解密库里已存的 API Key。');
  console.warn('    上线前请在 .env 里换成随机值：node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"');
}

await createNodeServer(app, { env, port: PORT, host: HOST });

console.log(`\n  LearnHub 后端  →  http://${HOST}:${PORT}`);
console.log(`  仅提供 /api/*（前端请另起 frontend/，默认 http://127.0.0.1:5173）`);
console.log('  演示账号：admin@demo.edu / teacher@demo.edu / student@demo.edu');
console.log('  密码：demo1234    课程邀请码：DEMO01');
if (env.LEARNHUB_CORS_ORIGIN && env.LEARNHUB_CORS_ORIGIN !== '*') {
  console.log(`  CORS 白名单：${env.LEARNHUB_CORS_ORIGIN}`);
} else {
  console.log('  CORS：放行任意来源（LEARNHUB_CORS_ORIGIN 可收窄为白名单）');
}
console.log('');
