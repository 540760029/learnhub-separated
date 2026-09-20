/**
 * 前端静态服务器测试
 *
 *   npm test
 *
 * 覆盖：静态文件与 MIME、SPA 深链接回退、缺失资源返回 404、目录穿越被拒，
 * 以及「config.js 必须先于 app.js 加载」这个容易踩的顺序问题。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createStaticServer } from '../server.js';

let server;
let base;

before(async () => {
  server = await createStaticServer({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

describe('前端静态资源', () => {
  it('首页返回 index.html', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.ok((await r.text()).includes('LearnHub'));
  });

  it('app.js / app.css / config.js 都能取到且 MIME 正确', async () => {
    const cases = [
      ['/app.js', /javascript/],
      ['/app.css', /text\/css/],
      ['/config.js', /javascript/],
    ];
    for (const [p, type] of cases) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, `${p} 应可访问`);
      assert.match(r.headers.get('content-type'), type, `${p} 的 MIME 不对`);
    }
  });

  it('index.html 里 config.js 排在 app.js 之前（否则读不到后端地址）', async () => {
    const html = await (await fetch(base + '/')).text();
    const cfg = html.indexOf('/config.js');
    const app = html.indexOf('/app.js');
    assert.ok(cfg > -1, 'index.html 必须引入 config.js');
    assert.ok(app > -1, 'index.html 必须引入 app.js');
    assert.ok(cfg < app, 'config.js 必须先于 app.js 加载');
  });

  it('SPA 回退：深链接返回 index.html', async () => {
    for (const p of ['/course/1', '/dashboard', '/settings']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.ok((await r.text()).includes('LearnHub'), p);
    }
  });

  it('缺失的静态文件与点文件都返回 404，不会回退成 HTML', async () => {
    // 若这里回退成 index.html，浏览器拿 .js 的内容却是 HTML，会报
    // "Unexpected token '<'"，是前端最难查的一类错，所以单独锁住行为。
    // 点文件（.env）尤其要小心：path.extname('.env') 返回空串，用错判据就会漏。
    for (const p of ['/not-exist.js', '/.env', '/.gitignore']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  });

  it('拒绝目录穿越，不会泄露仓库里的文件', async () => {
    // 注意：不能写成 /../../backend/.env —— fetch 会在发出前把 %2e%2e 规范化掉，
    // 那样根本打不到服务器的防护逻辑（这个测试会假通过）。
    // 用 %2f 编码斜杠，整段才不会在客户端被折叠。
    const r = await fetch(base + '/%2e%2e%2f%2e%2e%2fbackend%2f.env');
    assert.equal(r.status, 404);
    assert.ok(!(await r.text()).includes('LEARNHUB_DB_URL'), '绝不能泄露 backend/.env 内容');
  });
});
