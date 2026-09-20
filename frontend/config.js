/* ===================== LearnHub 前端运行时配置 =====================
 *
 * 前后端分离后，前端是纯静态资源，需要知道后端在哪。
 *
 * 后端地址的解析优先级（见 app.js 顶部）：
 *   1. 网址参数 ?api=http://192.168.1.10:8899   ← 临时指向别的后端，会被记住
 *   2. localStorage 里记住的 lh_api_base
 *   3. 本文件的 apiBase                          ← 默认值
 *
 * 默认值按访问环境自动选：
 *   · 本机开发（localhost / 127.0.0.1）→ 直连本机后端 8899
 *   · 其他环境（公网域名 / Nginx 同源） → 空串，走同源相对路径
 *
 * 为什么公网用同源：Cloudflare 隧道把 learn.lxf.life 做了路径分流，
 *   /api/*  → 后端 8899
 *   其余    → 前端 5173
 * 前后端同源，于是完全不需要 CORS。
 *
 * 想改回默认值：浏览器控制台执行 localStorage.removeItem('lh_api_base') 后刷新。
 */
(function () {
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  window.LEARNHUB_CONFIG = {
    apiBase: isLocal ? 'http://127.0.0.1:8899' : '',
  };
})();
