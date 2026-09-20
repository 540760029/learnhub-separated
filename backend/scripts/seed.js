#!/usr/bin/env node
/**
 * 灌演示数据
 *
 *   npm run db:seed
 *
 * 已有数据时什么都不做（只在空库上灌）。表必须先由 npm run db:migrate 建好。
 * 读取 LEARNHUB_DB_URL（可写在 backend/.env）。
 */
import { Db } from '../src/db.js';
import { seedDemoData } from '../src/bootstrap.js';
import { connectFromEnv } from '../src/drivers.js';

const driver = await connectFromEnv(process.env);
try {
  const db = new Db(driver);
  const seeded = await seedDemoData(db);
  console.log(seeded
    ? '✅ 已写入演示数据（admin@ / teacher@ / student@demo.edu，密码 demo1234，邀请码 DEMO01）'
    : 'ℹ️  库里已有数据，跳过（要重灌请先清空 users 表）');
} finally {
  await driver.close();
}
