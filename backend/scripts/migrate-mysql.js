#!/usr/bin/env node
/**
 * MySQL 迁移器 —— 建表（幂等，可反复执行）
 *
 *   npm run db:migrate
 *
 * 读取 migrations/mysql/0001_schema.sql（本项目唯一的 schema 事实来源）并逐条执行。
 *
 * 为什么要自己写迁移器，而不是 `mysql < file`：
 *   MySQL 不支持 CREATE INDEX IF NOT EXISTS（那是 MariaDB 扩展），所以脚本本身
 *   无法重复执行。这里容忍「已存在」类错误，让脚本可以反复跑而不报错。
 *
 * 环境变量：LEARNHUB_DB_URL=mysql://user:pass@host:3306/db（可写在 backend/.env）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMysqlDriver, parseMysqlUrl, splitStatements } from '../src/drivers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const url = String(process.env.LEARNHUB_DB_URL || '').trim();

if (!url) {
  console.error('❌ 需要 LEARNHUB_DB_URL，例如：');
  console.error('   LEARNHUB_DB_URL=mysql://root:密码@127.0.0.1:3306/learnhub');
  process.exit(1);
}

const cfg = parseMysqlUrl(url);
console.log(`[mysql] 连接 ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`);

const driver = await createMysqlDriver(cfg);
console.log('[mysql] 已连接');

const file = path.join(ROOT, 'migrations', 'mysql', '0001_schema.sql');
if (!fs.existsSync(file)) {
  console.error('❌ 找不到 migrations/mysql/0001_schema.sql');
  process.exit(1);
}

const sql = fs.readFileSync(file, 'utf8');
const statements = splitStatements(sql);
console.log(`[mysql] 共 ${statements.length} 条语句`);

let ok = 0;
let skipped = 0;
const failures = [];

for (const stmt of statements) {
  const head = stmt.replace(/\s+/g, ' ').slice(0, 70);
  try {
    await driver.pool.query(stmt);
    ok += 1;
  } catch (err) {
    if (driver.isDuplicateError(err)) {
      skipped += 1;                       // 表/索引已存在，属预期
      continue;
    }
    failures.push({ head, message: err.message, code: err.code });
  }
}

console.log(`[mysql] 成功 ${ok} 条，跳过（已存在）${skipped} 条`);
if (failures.length) {
  console.error(`\n❌ ${failures.length} 条失败：`);
  for (const f of failures) console.error(`   ${f.code || ''} ${f.message}\n     ← ${f.head}`);
  await driver.close();
  process.exit(1);
}

// 汇总校验
const [[counts]] = await driver.pool.query(`
  SELECT
    (SELECT COUNT(*) FROM users)            AS users,
    (SELECT COUNT(*) FROM courses)          AS courses,
    (SELECT COUNT(*) FROM knowledge_points) AS kps,
    (SELECT COUNT(*) FROM questions)        AS questions,
    (SELECT COUNT(*) FROM quiz_sets)        AS quizzes`);
console.log('[mysql] 数据校验:', JSON.stringify(counts));
await driver.close();
console.log('✅ 迁移完成');
