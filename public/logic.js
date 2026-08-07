/* ============================================================
 * public/logic.js — 纯函数层（前端与 node 单测共用）
 * 这里只放「无 DOM 依赖」的工具函数，便于在 test/run.js 直接 require 做单元测试。
 * 浏览器中作为普通 <script> 加载，函数挂到全局；node 中通过 module.exports 导出。
 * ============================================================ */

/* HTML 转义：所有用户内容渲染前必须经过它，防 XSS */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* 判断一份 JSON 是否为合法的 ROOT-OS 数据包（导入校验用） */
function isRootBag(d) {
  if (!d || typeof d !== 'object') return false;
  if (!Array.isArray(d.rules) || !Array.isArray(d.cats) || !Array.isArray(d.tags) || !Array.isArray(d.phases)) return false;
  if (typeof d.daily !== 'object' || d.daily === null) return false;
  return true;
}

/* 把正文里的网址变可点击链接：
 * - http(s):// 完整网址 与 裸域名(cs50.harvard.edu/x、ielts.neea.cn 等) → <a>
 * - 课程号(6.S081 / 18.06，二级标签无字母) 与 邮箱(前导 @) 不会被误链
 * 依赖 esc()：先转义再替换，保证生成的 href 不会被注入引号破坏 */
function linkify(txt) {
  let s = esc(txt || '');
  const re = /(https?:\/\/[^\s<>"']+)|(?<![.\w@])([a-z0-9-]*[a-z][a-z0-9-]*\.[a-z]{2,6})([^\s<>"'()\[\]{}]*)?/gi;
  return s.replace(re, (m, http, dom, path) => {
    if (http) {
      let u = http.replace(/[.,;:]+$/, '');
      return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>';
    }
    if (dom) {
      let p = path || '';
      while (/[.,;:]$/.test(p)) p = p.slice(0, -1);
      const url = 'https://' + dom + p;
      return '<a href="' + url + '" target="_blank" rel="noopener">' + dom + p + '</a>';
    }
    return m;
  });
}

/* 同时兼容浏览器(全局)与 node(模块)两种使用方式 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, isRootBag, linkify };
}
