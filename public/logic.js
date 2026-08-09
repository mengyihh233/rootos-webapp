/* ============================================================
 * public/logic.js — 纯函数层（前端与 node 单测共用）
 * 这里只放「无 DOM 依赖」的工具函数，便于在 test/run.js 直接 require 做单元测试。
 * 浏览器中作为普通 <script> 加载，函数挂到全局；node 中通过 module.exports 导出。
 * ============================================================ */

/* HTML 转义：所有用户内容渲染前必须经过它，防 XSS。
 * 覆盖 & < > " ' 五类字符（含单引号——若漏转，用户内容进入
 * onclick="fn('...')" 这类内联 JS 字符串时会被截断注入，构成存储型 XSS）。 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* JS 字符串上下文转义：用于把用户内容拼进 onclick="fn('...')" 的内联 JS 字符串。
 * 必须「先 JS 转义、再 HTML 转义」：
 *   1) 反斜杠 → \\（防止用户输入 \' 反杀转义）；
 *   2) 单引号 → \'（防止截断 JS 字符串）；
 *   3) esc() 处理 & < > "（HTML 属性层；其中 &quot; 在 HTML 解析后还原为 "，
 *      但它在 JS 单引号字符串内是普通字符，无害）。
 * 最终经 HTML 解析还原为 \'，JS 解析为字符串内的单引号——两层都安全。 */
function escJs(s) {
  return esc(String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

/* 判断一份 JSON 是否为合法的 ROOT-OS 数据包（导入校验用） */
function isRootBag(d) {
  /* 🔴 优先用共享 schema 定义（更完整），fallback 兼容测试环境（无 BAG_SCHEMA） */
  if (typeof BAG_SCHEMA !== 'undefined' && BAG_SCHEMA.isRootBag) return BAG_SCHEMA.isRootBag(d);
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

/* 数组合并（按 id 去重）：当前数据在前，模板数据追加在後；
 * 当 id 冲突时模板版本覆盖当前版本（同一 id 视为「同一事物的更新版」）。
 * 用于「套用模板·合并」模式，避免重复条目又能接收模板的改进。 */
function mergeById(cur, tpl) {
  const m = new Map();
  (cur || []).forEach(x => { if (x && x.id != null) m.set(x.id, x); });
  (tpl || []).forEach(x => { if (x && x.id != null) m.set(x.id, x); });
  return Array.from(m.values());
}

/* 复盘记录合并（按 day/week/month 子对象 key=日期 合并）：
 * 当前用户记录优先，模板中缺失的日期才补入，不覆盖用户已有复盘。 */
function mergeReviews(cur, tpl) {
  cur = cur || { day: {}, week: {}, month: {} };
  tpl = tpl || { day: {}, week: {}, month: {} };
  return {
    day: Object.assign({}, tpl.day || {}, cur.day || {}),
    week: Object.assign({}, tpl.week || {}, cur.week || {}),
    month: Object.assign({}, tpl.month || {}, cur.month || {}),
  };
}

/* 合并预览：对比当前(cur)与模板(tpl)，按 id 统计 新增 / 更新(同 id 内容不同) / 未变。
 * 用于「套用模板·合并」前提示用户哪些项会被模板覆盖（冲突可视化）。 */
function diffById(cur, tpl) {
  const curMap = new Map();
  (cur || []).forEach(x => { if (x && x.id != null) curMap.set(x.id, x); });
  const res = { added: [], updated: [], unchanged: [] };
  (tpl || []).forEach(x => {
    if (!x || x.id == null) return;
    if (!curMap.has(x.id)) res.added.push(x.id);
    else if (JSON.stringify(curMap.get(x.id)) !== JSON.stringify(x)) res.updated.push(x.id);
    else res.unchanged.push(x.id);
  });
  return res;
}

/* 选择性合并（按 id 去重 + 逐条决策）：
 * - tpl 中不存在于 cur 的 id → 一律追加（新增）
 * - tpl 与 cur 同 id 的项 → 由 choices[id] 决定：
 *     choices[id] === false  → 保留当前版本（用户勾选「保留我的」）
 *     其余（含未指定）       → 用模板版本（默认）
 * choices 为可选，缺省时等价于 mergeById（全用模板）。
 * 用于「套用模板·合并」的逐项冲突解决。 */
function mergeWithChoices(cur, tpl, choices) {
  const cmap = new Map();
  (cur || []).forEach(x => { if (x && x.id != null) cmap.set(x.id, x); });
  const out = Array.from(cmap.values());
  (tpl || []).forEach(t => {
    if (!t || t.id == null) return;
    if (!cmap.has(t.id)) { out.push(t); return; }            /* 新增：始终加 */
    if (choices && choices[t.id] === false) return;          /* 用户选择保留当前：不动 */
    const i = out.findIndex(x => x.id === t.id);
    if (i >= 0) out[i] = t;                                  /* 用模板版本 */
  });
  return out;
}

/* 同时兼容浏览器(全局)与 node(模块)两种使用方式 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc, escJs, isRootBag, linkify, mergeById, mergeReviews, diffById, mergeWithChoices };
}
