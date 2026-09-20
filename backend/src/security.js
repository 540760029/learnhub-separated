/**
 * 安全模块 —— 全部基于 WebCrypto（Node 内置，零第三方依赖）
 *
 *  * 密码：PBKDF2-HMAC-SHA256 + 随机盐，格式 pbkdf2_sha256$轮数$盐$哈希（base64）
 *  * 会话：HMAC-SHA256 签名的自包含 token（JWT 的极简等价物）
 *  * API Key：AES-256-GCM 加密后入库，密钥由 LEARNHUB_SECRET 派生
 *
 * 为什么不用 bcrypt / jsonwebtoken：WebCrypto 是平台内置能力，不需要编译原生模块，
 * 也省掉两个依赖；PBKDF2 10 万轮对本场景足够。
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

// Workers 上 crypto.subtle 是全局的；Node 20+ 也有全局 crypto
const webcrypto = globalThis.crypto;

/** PBKDF2 迭代次数。Workers 有 CPU 时间限制，10 万次是安全与耗时的折中。 */
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

// ------------------------------------------------------------------ 编码工具
export function b64urlEncode(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 定时安全比较，避免时序侧信道 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------------ 密码
export async function hashPassword(password) {
  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, iterStr, saltB64, wantB64] = String(stored).split('$');
    if (algo !== 'pbkdf2_sha256') return false;
    const iterations = parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const salt = base64ToBytes(saltB64);
    const want = new Uint8Array(base64ToBytes(wantB64));
    const got = new Uint8Array(await pbkdf2(password, salt, iterations));
    if (got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
    return diff === 0;
  } catch {
    return false;
  }
}

async function pbkdf2(password, salt, iterations) {
  const key = await webcrypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits'],
  );
  return webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BITS,
  );
}

// ------------------------------------------------------------------ 会话 token
export async function createToken(secret, payload, ttlSeconds = 7 * 24 * 3600) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(body)));
  const sig = await hmac(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

export async function decodeToken(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expect = await hmac(secret, payloadB64);
  if (!timingSafeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(payloadB64)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmac(secret, message) {
  const key = await webcrypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

// ------------------------------------------------------------------ API Key 加密
// AES-256-GCM：密钥由 LEARNHUB_SECRET 经 SHA-256 派生，每次加密随机 12 字节 IV
async function aesKey(secret) {
  const digest = await webcrypto.subtle.digest('SHA-256', enc.encode(secret));
  return webcrypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(secret, plain) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain));
  // 格式：v1.<iv_b64>.<密文_b64>
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptSecret(secret, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('密文格式不正确');
  const iv = base64ToBytes(parts[1]);
  const ct = base64ToBytes(parts[2]);
  const key = await aesKey(secret);
  const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(pt);
}

/** 只回显后 4 位，前端永远拿不到完整 key */
export function maskKey(key) {
  if (!key) return '';
  return key.length > 4 ? '••••••••' + key.slice(-4) : '••••';
}
