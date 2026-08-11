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

  // ── 🔴 数据自愈：修复规则树一致性（加载/保存前调用） ──
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

    // ③ 循环引用：A→B→A（同门类也可能发生）→ 断开环——多轮遍历直到稳定（每轮只断第一个发现的环，复杂情况多轮解）
    let changed = true;
    let round = 0;
    while (changed && round < bag.rules.length) {
      changed = false; round++;
      for (let i = 0; i < bag.rules.length; i++) {
        const r = bag.rules[i];
        if (!r || !r.parent) continue;
        let cur = r.parent, hops = 0;
        while (cur && hops < bag.rules.length + 1) {
          if (cur === r.id) { r.parent = null; changed = true; break; }
          const p = byId[cur];
          if (!p) break;
          cur = p.parent;
          hops++;
        }
      }
    }

    // ④ seq 规范化：同一 (cat, lv, parent) 组内 1..n（防排序错乱）
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

    // ⑤ 🔴 兜底：孤儿门类无主链——若某 cat 下没有任何主链（除自身外），把所有该 cat 下的支链恢复为主链
    // 场景：用户把所有规则都设成了支链 → 根部门类主链为 0 → 规则页"还没有规则"
    // 修复：把该 cat 下所有支链恢复为主链，保证每个门类至少有 1 条主链可见
    const mainByCat = {}; /* cat → Set of ruleId（主链） */
    bag.rules.forEach(r => {
      if (!r || !r.cat || r.parent) return;
      (mainByCat[r.cat] = mainByCat[r.cat] || new Set()).add(r.id);
    });
    bag.rules.forEach(r => {
      if (!r || !r.cat || !r.parent) return;
      /* 同门类主链为空（孤儿门类）→ 把所有该 cat 下的支链恢复为主链 */
      if (!(mainByCat[r.cat] && mainByCat[r.cat].size)) r.parent = null;
    });

    // ⑥ 🔴 补全缺失门类：规则引用了 cats 中不存在的门类（cats 丢失/被覆盖导致）
    // 场景：cats 只剩 2 个门类，但 45 条规则的 cat 指向 c_study/c_en 等已丢失的门类
    // → 规则页 cats.map 遍历不到 → "还没有规则"，今日页进度(不看cat)却正常
    // 修复：为所有被规则引用但不在 cats 里的 cat id 补一个门类（保留原 id，名字从 id 推断，颜色默认）
    if (!Array.isArray(bag.cats)) bag.cats = [];
    const haveCat = new Set(bag.cats.map(c => c && c.id));
    const missingCats = {};
    bag.rules.forEach(r => {
      if (r && r.cat && !haveCat.has(r.cat)) missingCats[r.cat] = true;
    });
    Object.keys(missingCats).forEach(cid => {
      const inferName = cid.replace(/^c_/, '').replace(/_/g, ' ');
      const pretty = inferName.charAt(0).toUpperCase() + inferName.slice(1);
      bag.cats.push({ id: cid, name: pretty || cid, color: '#4fc1ff' });
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
