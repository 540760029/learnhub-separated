/**
 * Node HTTP ↔ Fetch 适配器
 *
 * 核心应用是 Fetch 风格的（function handle(request, env) -> Response），
 * 本文件只负责把 Node 的 http.IncomingMessage / ServerResponse 翻译成 Request/Response。
 *
 * 本文件只做这一件事：把 Node 请求翻译成 Fetch 风格的 Request/Response。
 * 静态资源由 frontend/ 独立托管，这里不涉及。
 */
import http from 'node:http';

/** Node 请求 → 标准 Request */
export async function toFetchRequest(req, { origin = 'http://127.0.0.1' } = {}) {
  const url = new URL(req.url, origin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, String(v));
  }

  const method = (req.method || 'GET').toUpperCase();
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
    if (body.length === 0) body = undefined;
  }
  return new Request(url.toString(), { method, headers, body });
}

/** 标准 Response → Node 响应 */
export async function sendFetchResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // 避免与 Node 自带的 chunked/长度处理冲突
    if (key.toLowerCase() === 'content-encoding') return;
    try {
      res.setHeader(key, value);
    } catch { /* 忽略非法头 */ }
  });
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

/**
 * 启动一个 Node HTTP 服务器，把请求交给 Fetch 风格的 router
 * @returns {Promise<import('node:http').Server>}
 */
export function createNodeServer(router, { env = {}, port = 8899, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const request = await toFetchRequest(req, { origin: `http://${host}:${port}` });
      const response = await router.handle(request, env, {});
      await sendFetchResponse(res, response);
    } catch (err) {
      console.error('[node-adapter]', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify({ detail: '服务器内部错误' }));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
