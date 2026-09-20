/* ===================== LearnHub 前端运行时配置 =====================
 *
 * 前后端分离后，前端是纯静态资源，需要知道后端在哪。
 *
 * 后端地址的解析优先级（见 app.js 顶部）：
 *   1. 网址参数 ?api=http://192.168.1.10:8899   ← 临时指向别的后端，会被记住
 *   2. localStorage 里记住的 lh_api_base
 *   3. 本文件的 apiBase                          ← 默认值
 *
 * 想改回默认值：浏览器控制台执行 localStorage.removeItem('lh_api_base') 后刷新。
 */
window.LEARNHUB_CONFIG = {
  // 后端地址（不带结尾斜杠）。留空字符串表示同源（由 Nginx 等反向代理到后端）。
  apiBase: 'http://127.0.0.1:8899',
};
