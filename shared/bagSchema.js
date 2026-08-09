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

  const schema = { BAG_FIELDS, BAG_VERSION, emptyBag, mergeById, migrateBag, isRootBag, cloneBag };

  // UMD: Node / 浏览器 / 小程序 通用
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = schema;
  } else {
    root.BAG_SCHEMA = schema;
  }

})(typeof self !== 'undefined' ? self : typeof global !== 'undefined' ? global : this);
