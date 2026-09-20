#!/usr/bin/env node
/**
 * 建库（若不存在）
 *
 *   npm run db:create
 *
 * 只创建数据库本身，不建表 —— 建表交给 npm run db:migrate。
 * 读取 LEARNHUB_DB_URL（可写在 backend/.env）。
 */
import { createMysqlDriver, parseMysqlUrl } from '../src/drivers.js';

const url = String(process.env.LEARNHUB_DB_URL || '').trim();
if (!url) {
  console.error('❌ 缺少 LEARNHUB_DB_URL，例如：');
  console.error('   LEARNHUB_DB_URL=mysql://root:密码@127.0.0.1:3306/learnhub');
  process.exit(1);
}

const cfg = parseMysqlUrl(url);

// 库名要拼进 SQL，这里先严格校验，避免连接串里塞进反引号做注入
if (!/^[A-Za-z0-9_]+$/.test(cfg.database)) {
  console.error(`❌ 非法库名：${cfg.database}（只允许字母、数字、下划线）`);
  process.exit(1);
}

// 不指定 database 连接，否则库不存在时连不上
const driver = await createMysqlDriver({ ...cfg, database: undefined });
try {
  await driver.pool.query(
    `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` `
    + 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  );
  console.log(`✅ 数据库就绪：${cfg.database}（${cfg.user}@${cfg.host}:${cfg.port}）`);
  console.log('   下一步：npm run db:migrate');
} finally {
  await driver.close();
}
