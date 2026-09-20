#!/usr/bin/env node
/**
 * 生成 PBKDF2 密码哈希（与 src/security.js 的 verifyPassword 对应）
 *
 * 用法：
 *   node scripts/hash-password.js                 # 生成 demo1234 的哈希
 *   node scripts/hash-password.js 我的密码
 *   node scripts/hash-password.js --sql           # 顺便输出可直接粘进迁移文件的 SQL
 */
import { hashPassword } from '../src/security.js';

const args = process.argv.slice(2);
const wantSql = args.includes('--sql');
const password = args.find((a) => !a.startsWith('--')) || 'demo1234';

const hash = await hashPassword(password);

console.log('password :', password);
console.log('hash     :', hash);
if (wantSql) {
  console.log('\n-- 供 migrations 使用的 SQL 片段：');
  console.log(`-- ${password}`);
  console.log(`'${hash}'`);
}
