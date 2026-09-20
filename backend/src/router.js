/**
 * 极简 Fetch 原生路由器
 *
 * 为什么不用 Express：Express 依赖 on-finished 读取 req.socket，业务代码就得
 * 绑死在 Node 的 http 对象上；这里只用 Request/Response 标准 API，
 * 于是测试可以直接对真实端口发 fetch，也可以绕过网络直接调 handle()。
 *
 * 这个路由器零依赖，Node 18+ / Deno / Bun 都能直接跑。
 *
 * 用法：
 *   const r = new Router();
 *   r.get('/api/courses/:cid', async (c) => c.json({...}));
 *   r.handle(request, env, ctx);
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const httpError = (status, message) => new HttpError(status, message);

/** 把 '/api/courses/:cid/knowledge' 编译成正则 + 参数名 */
function compile(pattern) {
  const names = [];
  const source = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')          // 转义正则元字符（先处理，避免影响 :param）
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { re: new RegExp(`^${source}/?$`), names };
}

class Ctx {
  constructor({ req, env, ctx, params, url, router }) {
    this.req = req;
    this.env = env;
    this.ctx = ctx;
    this.params = params;
    this.url = url;
    this.router = router;
    this._body = undefined;
    this.user = null;
  }

  get method() { return this.req.method; }
  get path() { return this.url.pathname; }
  /** 取查询参数（?q=xxx） */
  query(name) { return name ? this.url.searchParams.get(name) : this.url.searchParams; }
  /** 请求头（大小写不敏感） */
  header(name) { return this.req.headers.get(name); }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  text(body, status = 200) {
    return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  /** 解析 JSON 请求体；非 JSON 或空体返回 {} */
  async body() {
    if (this._body !== undefined) return this._body;
    const method = this.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return (this._body = {});
    const ct = this.req.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      // 非 JSON（例如 multipart）时把原始字节留好，交给业务代码处理
      this._raw = null;
      const buf = await this.req.arrayBuffer().catch(() => null);
      this._raw = buf ? new Uint8Array(buf) : null;
      return (this._body = {});
    }
    try {
      this._body = (await this.req.json()) ?? {};
    } catch {
      this._body = {};
    }
    return this._body;
  }

  /** 原始请求字节（multipart 等场景用） */
  async raw() {
    if (this._raw === undefined) await this.body();
    return this._raw ?? null;
  }

  /** multipart 解析：把原始字节还原成 Request 再调 formData() */
  async formData() {
    const ct = this.req.headers.get('content-type') || '';
    if (!ct.includes('multipart/form-data')) throw httpError(400, '请使用 multipart/form-data 上传文件');
    const raw = await this.raw();
    const req2 = new Request('https://upload.local/', { method: 'POST', headers: { 'content-type': ct }, body: raw });
    return req2.formData();
  }
}

export class Router {
  constructor() {
    this.routes = [];
    this.middlewares = [];
    this.fallback = null;
    this.errorHandler = null;
  }

  use(fn) {
    this.middlewares.push(fn);
    return this;
  }

  _add(method, pattern, handler) {
    if (pattern === '*') {
      this.fallback = handler;
      return this;
    }
    const { re, names } = compile(pattern);
    this.routes.push({ method, re, names, handler, pattern });
    return this;
  }

  get(p, h) { return this._add('GET', p, h); }
  post(p, h) { return this._add('POST', p, h); }
  patch(p, h) { return this._add('PATCH', p, h); }
  put(p, h) { return this._add('PUT', p, h); }
  delete(p, h) { return this._add('DELETE', p, h); }
  all(p, h) { return this._add('*', p, h); }

  onError(fn) {
    this.errorHandler = fn;
    return this;
  }

  async handle(req, env = {}, execCtx = {}) {
    const url = new URL(req.url);
    // 关键：一次请求只创建一个上下文，中间件写进去的状态（例如 c.user）
    // 必须能被后续中间件和路由处理器看到。早期实现为每个中间件新建 Ctx，
    // 导致鉴权结果被丢弃、所有需要登录的接口都返回 401。
    const c = new Ctx({ req, env, ctx: execCtx, params: {}, url, router: this });
    try {
      for (const mw of this.middlewares) {
        const early = await mw(c);
        if (early instanceof Response) return early;
      }
      for (const route of this.routes) {
        if (route.method !== '*' && route.method !== req.method) continue;
        const m = route.re.exec(url.pathname);
        if (!m) continue;
        c.params = {};
        route.names.forEach((n, i) => { c.params[n] = decodeURIComponent(m[i + 1]); });
        const out = await route.handler(c);
        if (out instanceof Response) return out;
        return c.json({ detail: '处理器没有返回响应' }, 500);
      }
      if (this.fallback) {
        const out = await this.fallback(c);
        if (out instanceof Response) return out;
      }
      return new Response(JSON.stringify({ detail: '接口或资源不存在' }), {
        status: 404, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      if (this.errorHandler) {
        const out = await this.errorHandler(err, c);
        if (out instanceof Response) return out;
      }
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error('[error]', err);
      return new Response(JSON.stringify({ detail: err.message || '服务器内部错误' }), {
        status, headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  }
}

export { httpError };
