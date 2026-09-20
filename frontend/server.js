#!/usr/bin/env node
/**
 * LearnHub 前端静态服务器（零依赖 · 零构建）
 *
 *   npm start            → http://127.0.0.1:5173
 *   PORT=3000 npm start
 *
 * 只做两件事：发静态文件、把无扩展名的路径（SPA 深链接）回退到 index.html。
 *
 * 刻意不做反向代理：前端直接跨源调用后端，后端已开 CORS
 * （见 backend/src/app.js，用 LEARNHUB_CORS_ORIGIN 收窄来源）。
 * 部署时更推荐让 Nginx 既发静态文件、又把 /api 反代到后端（见 README）。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 请求路径 → 实际文件
 *
 * · 目录穿越（../）靠 resolve + 根目录前缀校验拦掉
 * · 没有扩展名的路径视为 SPA 路由，回退到 index.html
 *   （有扩展名却没命中就老实 404，避免把缺失的 .js 当成 HTML 返回，
 *     否则浏览器会报 "Unexpected token '<'" 这种难查的错）
 */
export function resolveFile(root, urlPath) {
  const target = path.resolve(root, '.' + (urlPath.startsWith('/') ? urlPath : '/' + urlPath));
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  try {
    if (fs.statSync(target).isFile()) return target;
  } catch { /* 不存在，继续尝试 SPA 回退 */ }

  // SPA 回退：只对「最后一段不含点」的路径生效。
  // 不用 path.extname —— 它对点文件（.env）返回空串，会把点文件误判成路由。
  if (!path.basename(target).includes('.')) {
    const index = path.join(root, 'index.html');
    if (fs.existsSync(index)) return index;
  }
  return null;
}

/** @returns {Promise<import('node:http').Server>} 已开始监听 */
export function createStaticServer({ root = ROOT, port = 5173, host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
      return res.end('Method Not Allowed');
    }

    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Bad Request');
    }

    const file = resolveFile(root, urlPath);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': String(fs.statSync(file).size),
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

// 只有直接 `node server.js` 时才启动监听（被 import 时不启动，便于测试）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.PORT || 5173);
  const HOST = process.env.HOST || '127.0.0.1';
  await createStaticServer({ port: PORT, host: HOST });
  console.log(`\n  LearnHub 前端  →  http://${HOST}:${PORT}`);
  console.log('  后端地址：config.js 里的 apiBase（默认 http://127.0.0.1:8899）');
  console.log('  临时切换后端：加网址参数 ?api=http://192.168.1.10:8899\n');
}
