# LearnHub 前端

零构建的原生 HTML / CSS / JS 单页应用，**独立于后端部署**，通过跨源请求调用后端 `/api/*`。

## 快速开始

```bash
# 1) 先把后端跑起来（另开一个终端）
cd ../backend && npm start          # → http://127.0.0.1:8899

# 2) 再起前端
npm start                            # → http://127.0.0.1:5173
```

打开 **http://127.0.0.1:5173**，用演示账号登录：

| 身份 | 邮箱 | 密码 |
|---|---|---|
| 管理员 | `admin@demo.edu` | `demo1234` |
| 教师 | `teacher@demo.edu` | `demo1234` |
| 学生 | `student@demo.edu` | `demo1234` |

## 后端地址怎么配

前端是纯静态资源，必须知道后端在哪。解析优先级：

1. **网址参数** `?api=http://192.168.1.10:8899` —— 临时指向别的后端，会被记进 localStorage
   （适合用手机连你电脑上的服务来测）
2. **localStorage** 里记住的 `lh_api_base`
3. **`config.js` 里的 `apiBase`** —— 默认值，按访问环境自动选：

```js
// config.js
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
window.LEARNHUB_CONFIG = {
  apiBase: isLocal ? 'http://127.0.0.1:8899' : '',   // 结尾不要加斜杠
};
```

| 访问方式 | apiBase | 请求实际发往 |
|---|---|---|
| 本机 `127.0.0.1:5173` | `http://127.0.0.1:8899` | 直连本机后端 |
| 公网域名（走 Cloudflare 隧道 / Nginx） | `''`（空串＝同源） | 同域名的 `/api/*`，由隧道或 Nginx 分流到后端 |

所以同一份前端代码，本机开发和走隧道上线都不用改配置。

想恢复默认值：浏览器控制台执行 `localStorage.removeItem('lh_api_base')` 后刷新。

> 直连后端（`apiBase` 非空）时才算跨源，后端默认 `LEARNHUB_CORS_ORIGIN=*` 放行全部；
> 上生产建议收窄成白名单。
> 走隧道/Nginx 时是同源，浏览器根本不触发跨源，CORS 用不到。

## 目录结构

```
frontend/
├── index.html    页面骨架（登录/注册 + 主应用外壳 + 全部视图的 SPA）
├── app.css       全部样式
├── app.js        全部交互逻辑（路由、请求封装、各视图渲染）
├── config.js     运行时配置：后端地址
├── server.js     零依赖静态服务器（开发用）
└── test/         静态服务测试（MIME、SPA 回退、目录穿越防护）
```

## 脚本

| 命令 | 作用 |
|---|---|
| `npm start` | 起静态服务器（默认 5173） |
| `npm run dev` | 同上，但文件变更自动重启 |
| `npm test` | 6 项静态服务测试 |

端口用 `PORT` 覆盖：`PORT=3000 npm start`。

## 测试

```bash
npm test
```

覆盖：静态文件与 MIME、SPA 深链接回退、缺失资源与点文件返回 404（不回退成 HTML）、
目录穿越被拒、`config.js` 必须排在 `app.js` 之前。

## 部署

前端是纯静态资源，扔到任何静态托管都行。推荐用 Nginx 同时发静态文件并把 `/api` 反代到后端
（这样前后端同源，连 CORS 都不用配）：

```nginx
server {
  listen 443 ssl;
  server_name learn.你的域名.com;

  # 前端静态文件
  root /opt/learnhub/frontend;
  index index.html;

  # SPA 深链接回退
  location / {
    try_files $uri $uri/ /index.html;
  }

  # 后端接口
  location /api/ {
    proxy_pass http://127.0.0.1:8899;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

同源部署时 `config.js` 的 `apiBase` 会自动取空串（非 localhost 环境），请求走相对路径 ——
不用手改。若你的域名恰好是 localhost，或想强制同源，加网址参数 `?api=` 传空值即可。

> 另一条同样同源、且不用买服务器的路子：Cloudflare Tunnel 路径分流。
> 见仓库根目录 [README](../README.md) 的「Cloudflare Tunnel」一节。

> ⚠️ 国内服务器绑域名必须备案，否则 80/443 会被拦。
