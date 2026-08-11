/* ============================================================
 * ROOT-OS Bag Schema — 共享数据格式定义
 * 用法：
 *   Node:  const { BAG_FIELDS } = require('./shared/bagSchema');
 *   浏览器: <script src="/shared/bagSchema.js"></script> → BAG_SCHEMA.BAG_FIELDS
 *   小程序: 复制本文件内容到 utils/bagSchema.js
 *
 * 🔴 这是系统数据契约——修改字段名/结构时，只改这里，然后
 *    全部引用点自动生效（不再需要逐个文件改字符串）。
 * ============================================================ */

(function (root) {
  'use strict';

  // ── 字段白名单 ──
  const BAG_FIELDS = {
    /** 数组型顶级字段（按 id 去重合并） */
    arrays: ['cats', 'levels', 'rules', 'tags', 'phases', 'resources', 'retros', 'retroEvents'],
    /** 对象型顶级字段（浅合并） */
    objects: ['daily', 'events', 'reviews', 'meta'],
    /** 敏感字段（sanitize 时清除，不可通过 PUT 存储） */
    sensitive: ['meta.ghToken', 'meta._seed'],
    /** 所有顶级字段（按顺序） */
    all: ['cats', 'levels', 'rules', 'tags', 'daily', 'events', 'phases', 'reviews', 'retros', 'resources', 'retroEvents', 'meta']
  };

  // ── Schema 版本 ──
  const BAG_VERSION = 1;

  // ── 默认空包骨架（供新用户/模板使用） ──
  function emptyBag() {
    return {
      cats: [], levels: [], rules: [], tags: [],
      daily: {}, events: {}, phases: [],
      reviews: {}, retros: [], resources: [], retroEvents: [],
      meta: { schemaVersion: BAG_VERSION }
    };
  }

  // ── 按 id 去重合并两个数组（模板合并基础操作） ──
  function mergeById(current, incoming) {
    if (!Array.isArray(current)) current = [];
    if (!Array.isArray(incoming)) incoming = [];
    const map = new Map();
    current.forEach(item => { if (item && item.id) map.set(item.id, item); });
    incoming.forEach(item => { if (item && item.id) map.set(item.id, item); });
    return Array.from(map.values());
  }

  // ── 版本迁移（渐进式兼容，旧数据升级到新格式） ──
  function migrateBag(bag, fromVersion) {
    if (!bag || typeof bag !== 'object') return bag;
    if (!bag.meta) bag.meta = {};

    const v = fromVersion || bag.meta.schemaVersion || 0;

    if (v < 1) {
      // v0 → v1: 补缺失字段默认值
      if (!Array.isArray(bag.retroEvents)) bag.retroEvents = [];
      if (!bag.meta) bag.meta = {};
      bag.meta.schemaVersion = 1;
    }
    // 未来 v2: if (v < 2) { ... }

    return bag;
  }

  // ── 校验是否为合法 bag ──
  function isRootBag(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return Array.isArray(obj.rules) && Array.isArray(obj.cats)
      && Array.isArray(obj.tags) && Array.isArray(obj.phases)
      && obj.daily && typeof obj.daily === 'object';
  }

  // ── 深复制 bag（数组按 id 去重，对象浅合并） ──
  function cloneBag(bag) {
    const out = {};
    BAG_FIELDS.arrays.forEach(k => { out[k] = (bag[k] || []).slice(); });
    BAG_FIELDS.objects.forEach(k => { out[k] = Object.assign({}, bag[k] || {}); });
    return out;
  }

  // ── 🔴 数据自愈：修复规则树一致性（加载/保存前调用，与小程序 utils/bagSchema.js 保持一致） ──
  // 规则模型：parent=null 主链（属于门类 cat + 层级 lv）；parent=X.id 支链（必须与 X 同门类）
  // 修复：①跨门类支链→恢复主链 ②parent 悬空→恢复主链 ③循环引用→断开 ④seq 规范化
  function repairBag(bag) {
    if (!bag || !Array.isArray(bag.rules)) return bag;
    const ids = new Set(bag.rules.map(r => r && r.id));
    const byId = {};
    bag.rules.forEach(r => { if (r && r.id) byId[r.id] = r; });

    // ① ② 跨门类 / 悬空 parent → 恢复主链
    bag.rules.forEach(r => {
      if (!r) return;
      if (r.parent && (!ids.has(r.parent) || (byId[r.parent] && byId[r.parent].cat !== r.cat))) {
        r.parent = null;
      }
    });

    // ③ 循环引用：A→B→A（同门类也可能发生）→ 断开环
    for (let i = 0; i < bag.rules.length; i++) {
      const r = bag.rules[i];
      if (!r || !r.parent) continue;
      let cur = r.parent, hops = 0;
      while (cur && hops < bag.rules.length + 1) {
        if (cur === r.id) { r.parent = null; break; }
        const p = byId[cur];
        if (!p) break;
        cur = p.parent;
        hops++;
      }
    }

    // ④ seq 规范化：同一 (cat, lv, parent) 组内 1..n
    const groups = {};
    bag.rules.forEach(r => {
      if (!r) return;
      const key = (r.cat || '') + '|' + (r.lv || '') + '|' + (r.parent || '');
      (groups[key] = groups[key] || []).push(r);
    });
    Object.values(groups).forEach(list => {
      list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      list.forEach((r, i) => { r.seq = i + 1; });
    });

    return bag;
  }

  const schema = { BAG_FIELDS, BAG_VERSION, emptyBag, mergeById, migrateBag, isRootBag, cloneBag, repairBag };

  // UMD: Node / 浏览器 / 小程序 通用
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = schema;
  } else {
    root.BAG_SCHEMA = schema;
  }

})(typeof self !== 'undefined' ? self : typeof global !== 'undefined' ? global : this);
