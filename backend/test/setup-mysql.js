/**
 * 测试库准备：DROP + CREATE 一个干净的测试库，然后建表
 *
 * ⚠️ 安全保护：库名必须严格匹配 `^[A-Za-z0-9_]+_test$`，否则直接拒绝运行。
 *    因为本模块会 DROP DATABASE —— 万一 LEARNHUB_TEST_DB_URL 被误配成业务库，
 *    这道校验就是最后一道防线。测试永远只认 LEARNHUB_TEST_DB_URL，
 *    不会去读 LEARNHUB_DB_URL，从根本上避免碰生产库。
 */
import { Db } from '../src/db.js';
import { readSchemaSql } from '../src/bootstrap.js';
import { createMysqlDriver, parseMysqlUrl } from '../src/drivers.js';

/** 未配置时的默认值（无密码的本地 root，够用作开箱默认） */
export const DEFAULT_TEST_DB_URL = 'mysql://root@127.0.0.1:3306/learnhub_test';

export function testDbUrl(env = process.env) {
  return String(env.LEARNHUB_TEST_DB_URL || '').trim() || DEFAULT_TEST_DB_URL;
}

export async function prepareTestDatabase(env = process.env) {
  const cfg = parseMysqlUrl(testDbUrl(env));

  if (!/^[A-Za-z0-9_]+_test$/.test(cfg.database)) {
    throw new Error(
      `拒绝在库 "${cfg.database}" 上运行测试：LEARNHUB_TEST_DB_URL 的库名`
      + '必须匹配 ^[A-Za-z0-9_]+_test$（测试会 DROP DATABASE 重建，防止误删业务库）。',
    );
  }

  // 1) 重建空库：不指定 database 连接，这样库不存在时也能连上
  const admin = await createMysqlDriver({ ...cfg, database: undefined });
  try {
    await admin.pool.query(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
    await admin.pool.query(
      `CREATE DATABASE \`${cfg.database}\` `
      + 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    );
  } finally {
    await admin.close();
  }

  // 2) 建表（走真实迁移脚本，顺带验证 schema 本身可用）
  const driver = await createMysqlDriver(cfg);
  const db = new Db(driver);
  const statements = await db.execScript(readSchemaSql());
  return { driver, db, cfg, statements };
}
