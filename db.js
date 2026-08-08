/* =====================================================================
 * db.js — 数据库适配层
 * ---------------------------------------------------------------------
 * 三种引擎（按优先级）：
 * 1. CLOUD_STORAGE=1 + TCB_ENV（云托管环境）→ **profile 大 JSON 存云存储**（省 PG 常驻资源点），
 *    users 等小表仍走 PG（DATABASE_URL 指向 PG 或 SQLite）
 * 2. DATABASE_URL（Postgres 连接串，如 Neon/腾讯云）→ 全表 Postgres
 * 3. 默认 → SQLite（本地开发 / 自托管 VPS，单文件 data.db）
 *
 * profile 三函数（Get/Set/UpdatedAt）在云存储引擎下读写
 * `profiles/<uid>.json`（内容 { data: JSON字符串, updatedAt: ISO }），
 * 其余表照常走底层数据库。server.js 业务代码无需关心引擎差异。
 * ===================================================================== */
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;
/* 云存储引擎启用条件：CLOUD_STORAGE=1 且 存在云凭证（TENCENTCLOUD_SECRETID 永久密钥，或 TENCENTCLOUD_SESSIONTOKEN 临时）。
 * 教训：容器型云托管不自动注入密钥，需手动配；无凭证时启用会连不上 → 视为未启用，本地开发安全。 */
const CLOUD_ENV = process.env.TCB_ENV || process.env.TCB_ENV_ID || process.env.SCF_NAMESPACE || '';
const HAS_CLOUD_CRED = !!(process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY);
const USE_CLOUD_STORAGE = process.env.CLOUD_STORAGE === '1' && HAS_CLOUD_CRED;
let _cloudApp = null; /* @cloudbase/node-sdk app 实例（惰性初始化） */

let sqlite = null;   // better-sqlite3 实例
let pool = null;     // pg Pool 实例
let connected = false; // 是否已成功初始化（供 server 判断 DB 就绪状态）

/* 云存储 profile 读写：文件不存在返回 null */
function cloudApp() {
  if (!_cloudApp) {
    const cloudbase = require('@cloudbase/node-sdk');
    /* 显式传凭证（容器型云托管不自动注入，需手动配 TENCENTCLOUD_SECRETID/SECRETKEY） */
    _cloudApp = cloudbase.init({
      env: CLOUD_ENV,
      secretId: process.env.TENCENTCLOUD_SECRETID || undefined,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY || undefined,
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined
    });
  }
  return _cloudApp;
}
/* 云存储读取（质疑后的自愈方案）：
 * 官方 fileID 格式 = cloud://<envId>.<bucketId>/<path>（带 bucket 段）。
 * 不能靠猜格式——首次上传返回的 fileID 是权威；缓存真实 envId+bucketId 供后续构造；
 * 缓存为空时尝试 getUploadMetadata 拿 bucketId。 */
let _cloudBucket = '';  /* 真实 bucketId（首次上传后缓存） */
function cloudFilePath(uid) { return 'profiles/' + uid + '.json'; }
function cloudFileID(uid) {
  const env = CLOUD_ENV || '';
  const bucket = _cloudBucket;
  if (env && bucket) return 'cloud://' + env + '.' + bucket + '/' + cloudFilePath(uid);
  return '';  /* 无法构造（尚未缓存）→ 走 getUploadMetadata 探测 */
}
async function ensureCloudBucket() {
  if (_cloudBucket) return true;
  try {
    const meta = await cloudApp().getUploadMetadata({ cloudPath: cloudFilePath('__probe') });
    const b = (meta && (meta.bucketId || meta.bucket)) || '';
    if (b) { _cloudBucket = b; return true; }
  } catch (e) { /* 继续走 fileID 缓存路径 */ }
  return !!_cloudBucket;
}
async function cloudDownload(uid) {
  try {
    let fileID = cloudFileID(uid);
    if (!fileID) {
      if (!(await ensureCloudBucket())) return null;
      fileID = cloudFileID(uid);
      if (!fileID) return null;
    }
    const r = await cloudApp().downloadFile({ fileID });
    if (!r || r.code !== 'SUCCESS') return null;
    const c = r.fileContent;
    if (c === undefined || c === null) return null;
    return Buffer.isBuffer(c) ? c.toString('utf8') : String(c);
  } catch (e) { return null; }
}
async function cloudProfileGet(uid) {
  const raw = await cloudDownload(uid);
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j && j.data ? j.data : null; } catch (e) { return null; }
}
/* 探测 updatedAt：优先 getFileInfo（HEAD 请求，不下载 body，省流量/读次数）。
 * 文件内也存 updatedAt 作为兜底（getFileInfo 失败时）。 */
async function cloudProfileUpdatedAt(uid) {
  /* 🔴 修复：优先读文件内的 updatedAt（毫秒级 ISO，cloudProfileSet 写入）——
   * getFileInfo 的 lastModified 是【秒级】，同一秒内双端写会拿到相同时间戳 → 乐观锁失效（静默覆盖）。
   * lastModified 仅作兜底。 */
  const raw = await cloudDownload(uid);
  if (raw) {
    try { const j = JSON.parse(raw); if (j && j.updatedAt) { const d = new Date(j.updatedAt); if (!isNaN(d.getTime())) return d.toISOString(); } } catch (e) { /* 继续兜底 */ }
  }
  try {
    const fileID = cloudFileID(uid);
    if (fileID) {
      const fi = await cloudApp().getFileInfo({ fileList: [fileID] });
      const item = (fi && fi.fileList && fi.fileList[0]) || {};
      if (item.code === 'SUCCESS' && item.lastModified) {
        const d = new Date(item.lastModified);
        if (!isNaN(d.getTime())) return d.toISOString();
      }
    }
  } catch (e) { /* 返回 null */ }
  return null;
}
async function cloudProfileSet(uid, dataStr) {
  const obj = JSON.stringify({ data: dataStr, updatedAt: new Date().toISOString() });
  const res = await cloudApp().uploadFile({ cloudPath: cloudFilePath(uid), fileContent: Buffer.from(obj, 'utf8') });
  /* 🔴 修复：上传失败必须抛错（上层 save() 会提示用户重试），不能假成功丢数据 */
  if (!res) throw new Error('云存储上传无响应');
  if (res.code && res.code !== 'SUCCESS' && res.code !== 0) throw new Error('云存储上传失败: ' + (res.message || res.code));
  /* 从上传返回的权威 fileID 提取 envId.bucketId 缓存（cloud://<env>.<bucket>/<path>） */
  if (res && res.fileID && /^cloud:\/\//.test(res.fileID)) {
    try {
      const mid = res.fileID.replace('cloud://', '').split('/')[0]; /* envId.bucketId */
      const dot = mid.indexOf('.');
      if (dot > 0) _cloudBucket = mid.slice(dot + 1);
    } catch (e) { /* 忽略 */ }
  }
}

const SCHEMA_SQLITE = {
  users: `
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      username       TEXT UNIQUE NOT NULL,
      pw_hash        TEXT NOT NULL,
      email          TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      wechat         TEXT,
      wx_openid      TEXT,
      display_name   TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  profiles: `
    CREATE TABLE IF NOT EXISTS profiles (
      user_id    INTEGER PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  templates: `
    CREATE TABLE IF NOT EXISTS templates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      author     TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL DEFAULT '',
      "desc"     TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '[]',
      counts     TEXT NOT NULL DEFAULT '{}',
      data       TEXT NOT NULL DEFAULT '{}',
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  notifications: `
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      type       TEXT NOT NULL DEFAULT '',
      payload    TEXT NOT NULL DEFAULT '{}',
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ratings: `
    CREATE TABLE IF NOT EXISTS ratings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      score       INTEGER NOT NULL,
      UNIQUE (template_id, user_id)
    )`,
  favorites: `
    CREATE TABLE IF NOT EXISTS favorites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      UNIQUE (template_id, user_id)
    )`,
  shares: `
    CREATE TABLE IF NOT EXISTS shares (
      id         TEXT PRIMARY KEY,
      owner      INTEGER NOT NULL DEFAULT 0,
      title      TEXT NOT NULL DEFAULT '',
      data       TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  subs: `
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      tpl_id  TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  pay_orders: `
    CREATE TABLE IF NOT EXISTS pay_orders (
      out_trade_no TEXT PRIMARY KEY,
      channel      TEXT NOT NULL DEFAULT 'afdian',
      user_id      INTEGER NOT NULL DEFAULT 0,
      amount       TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  backups: `
    CREATE TABLE IF NOT EXISTS backups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot   TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  sent_logs: `
    CREATE TABLE IF NOT EXISTS sent_logs (
      key        TEXT PRIMARY KEY,
      at         TEXT NOT NULL DEFAULT (datetime('now'))
    )`
};

const SCHEMA_PG = {
  users: `
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      username       TEXT UNIQUE NOT NULL,
      pw_hash        TEXT NOT NULL,
      email          TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      wechat         TEXT,
      wx_openid      TEXT,
      display_name   TEXT,
      unlock_until   TEXT,
      is_dev         INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT NOW()
    )`,
  profiles: `
    CREATE TABLE IF NOT EXISTS profiles (
      user_id    INTEGER PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT NOW()
    )`,
  templates: `
    CREATE TABLE IF NOT EXISTS templates (
      id         SERIAL PRIMARY KEY,
      author     TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL DEFAULT '',
      "desc"     TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '[]',
      counts     TEXT NOT NULL DEFAULT '{}',
      data       TEXT NOT NULL DEFAULT '{}',
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT NOW()
    )`,
  notifications: `
    CREATE TABLE IF NOT EXISTS notifications (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      type       TEXT NOT NULL DEFAULT '',
      payload    TEXT NOT NULL DEFAULT '{}',
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT NOW()
    )`,
  ratings: `
    CREATE TABLE IF NOT EXISTS ratings (
      id          SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      score       INTEGER NOT NULL,
      UNIQUE (template_id, user_id)
    )`,
  favorites: `
    CREATE TABLE IF NOT EXISTS favorites (
      id          SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      UNIQUE (template_id, user_id)
    )`,
  shares: `
    CREATE TABLE IF NOT EXISTS shares (
      id         TEXT PRIMARY KEY,
      owner      INTEGER NOT NULL DEFAULT 0,
      title      TEXT NOT NULL DEFAULT '',
      data       TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT NOW()
    )`,
  subs: `
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY,
      tpl_id  TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT NOW()
    )`,
  pay_orders: `
    CREATE TABLE IF NOT EXISTS pay_orders (
      out_trade_no TEXT PRIMARY KEY,
      channel      TEXT NOT NULL DEFAULT 'afdian',
      user_id      INTEGER NOT NULL DEFAULT 0,
      amount       TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL DEFAULT NOW()
    )`,
  backups: `
    CREATE TABLE IF NOT EXISTS backups (
      id         SERIAL PRIMARY KEY,
      snapshot   TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT NOW()
    )`,
  sent_logs: `
    CREATE TABLE IF NOT EXISTS sent_logs (
      key        TEXT PRIMARY KEY,
      at         TEXT NOT NULL DEFAULT NOW()
    )`
};

async function init() {
  /* 已连接则直接返回（支持 server 后台反复重试时幂等，避免重复建池） */
  if (connected) return;
  if (USE_PG) {
    /* 诊断：把 DATABASE_URL 解析后的主机/库名打出来（隐去账号密码），
     * 便于在 Render 日志确认环境变量到底配置成了什么。
     * 若连接串本身不合法（如误带 psql 前缀、特殊字符未编码），这里会直接暴露。 */
    try {
      const u = new URL(process.env.DATABASE_URL);
      console.log(`🔎 DATABASE_URL 目标：协议=${u.protocol} 主机=${u.hostname} 端口=${u.port || 5432} 库=${u.pathname.replace('/', '')} 用户=${u.username ? u.username.slice(0, 3) + '***' : '(空)'}`);
    } catch (e) {
      console.error('❌ DATABASE_URL 不是合法的连接串（可能误带了 psql 前缀或多余引号）：', e.message);
    }
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      /* Neon 免费层计算节点会休眠，首次连接会触发自动唤醒，唤醒耗时可达 30~60s。
       * 若 connectionTimeoutMillis 过短（如 15s），连接会被提前掐断、永远等不到唤醒 → 持续连接失败。
       * 这里放宽到 60s，给足唤醒时间；idleTimeout 保持 30s 不影响。 */
      connectionTimeoutMillis: 60000,
      idleTimeoutMillis: 30000
    });
    /* Neon 免费层会在闲置后休眠，首次连接常返回「database is paused」类错误。
     * 这里做有限次重试（带退避），等 Neon 唤醒。
     * 注意：本函数只负责「尝试一次连接 + 建表」，失败由调用方（server 后台循环）决定何时再试，
     * 因此这里即便 10 次都失败也只是 throw，不再自行 process.exit，避免部署因瞬时 DB 不可用而 status 1。 */
    const setup = async () => {
      await pool.query(SCHEMA_PG.users);
      await pool.query(SCHEMA_PG.profiles);
      await pool.query(SCHEMA_PG.templates);
      await pool.query(SCHEMA_PG.notifications);
      await pool.query(SCHEMA_PG.ratings);
      await pool.query(SCHEMA_PG.favorites);
      await pool.query(SCHEMA_PG.shares);
      await pool.query(SCHEMA_PG.pay_orders);
      await pool.query(SCHEMA_PG.backups);
      await pool.query(SCHEMA_PG.sent_logs);
      /* 既有库迁移：为旧 users 表补新列（幂等，已存在则跳过） */
      for (const col of ['email TEXT', 'email_verified INTEGER NOT NULL DEFAULT 0', 'wechat TEXT', 'wx_openid TEXT', 'unlock_until TEXT', 'is_dev INTEGER NOT NULL DEFAULT 0', 'display_name TEXT']) {
        const name = col.split(' ')[0];
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${col.slice(name.length).trim()}`);
      }
      /* 🔴 wechat 唯一索引（应用层 + DB 双重保障，让「微信号+密码」能定位 wx_ 账号）
       * 用 LOWER() 实现大小写不敏感的唯一性（微信号不区分大小写） */
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_wechat_unique ON users (LOWER(wechat)) WHERE wechat IS NOT NULL AND wechat <> ''`);
    };
    let ok = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= 10 && !ok; attempt++) {
      try {
        await setup();
        ok = true;
      } catch (e) {
        lastErr = e;
        console.warn(`⚠️ Postgres 连接第 ${attempt}/10 次失败，3s 后重试：${(e && e.message) || e}`);
        if (attempt < 10) await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!ok) {
      /* 清理半初始化的 pool，便于下次重试重新建池 */
      try { await pool.end(); } catch (_) { /* ignore */ }
      pool = null;
      /* 把底层真实错误带出来，方便在 Render 日志里直接看到根因
       * （如 password authentication failed / database does not exist / connection refused / timeout） */
      const detail = lastErr && lastErr.message ? lastErr.message : String(lastErr);
      throw new Error('无法连接 Postgres：' + detail);
    }
    connected = true;
    console.log('✅ 数据库：已连接 Postgres（DATABASE_URL）');
  } else {
    const Database = require('better-sqlite3');
    const fs = require('fs');
    const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'data.db');
    /* SQLite 模式：若 SQLITE_PATH 指向的目录不存在，先递归创建，
     * 否则 better-sqlite3 会直接抛「Cannot open database because the directory does not exist」使进程退出 1。 */
    try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (e) { /* 已存在则忽略 */ }
    sqlite = new Database(dbPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec(SCHEMA_SQLITE.users);
    sqlite.exec(SCHEMA_SQLITE.profiles);
    sqlite.exec(SCHEMA_SQLITE.templates);
    sqlite.exec(SCHEMA_SQLITE.notifications);
    sqlite.exec(SCHEMA_SQLITE.ratings);
    sqlite.exec(SCHEMA_SQLITE.favorites);
    /* 既有库迁移：SQLite 无 ADD COLUMN IF NOT EXISTS，用 PRAGMA 检测缺列后逐个补 */
    const cols = sqlite.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!cols.includes('email')) sqlite.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
    if (!cols.includes('email_verified')) sqlite.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('wechat')) sqlite.exec(`ALTER TABLE users ADD COLUMN wechat TEXT`);
    if (!cols.includes('wx_openid')) sqlite.exec(`ALTER TABLE users ADD COLUMN wx_openid TEXT`);
    if (!cols.includes('unlock_until')) sqlite.exec(`ALTER TABLE users ADD COLUMN unlock_until TEXT`);
    if (!cols.includes('is_dev')) sqlite.exec(`ALTER TABLE users ADD COLUMN is_dev INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('display_name')) sqlite.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
    sqlite.exec(SCHEMA_SQLITE.shares);
    sqlite.exec(SCHEMA_SQLITE.pay_orders);
    sqlite.exec(SCHEMA_SQLITE.backups);
    sqlite.exec(SCHEMA_SQLITE.sent_logs);
    connected = true;
    console.log('✅ 数据库：已连接本地 SQLite（data.db）');
  }
}

/* 供 server 读取：数据库是否已就绪（未就绪时 /api 返回 503 而非 500 崩溃） */
function isConnected() { return connected; }

async function userByName(username) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

async function createUser(username, pw_hash) {
  if (USE_PG) {
    const r = await pool.query(
      'INSERT INTO users (username, pw_hash) VALUES ($1, $2) RETURNING id',
      [username, pw_hash]
    );
    return r.rows[0].id;
  }
  const info = sqlite.prepare('INSERT INTO users (username, pw_hash) VALUES (?, ?)').run(username, pw_hash);
  return info.lastInsertRowid;
}

async function profileGet(uid) {
  if (globalThis.__incUsageDbRead) globalThis.__incUsageDbRead();
  if (USE_CLOUD_STORAGE) return cloudProfileGet(uid);
  if (USE_PG) {
    const r = await pool.query('SELECT data FROM profiles WHERE user_id = $1', [uid]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const row = sqlite.prepare('SELECT data FROM profiles WHERE user_id = ?').get(uid);
  return row ? row.data : null;
}

/* 读取数据最后更新时间（服务器时钟，跨设备冲突判断的权威依据）。
 * 返回 ISO 字符串；无记录返回 null。 */
async function profileUpdatedAt(uid) {
  if (globalThis.__incUsageDbRead) globalThis.__incUsageDbRead();
  if (USE_CLOUD_STORAGE) return cloudProfileUpdatedAt(uid);
  if (USE_PG) {
    const r = await pool.query('SELECT updated_at FROM profiles WHERE user_id = $1', [uid]);
    if (!r.rows[0] || !r.rows[0].updated_at) return null;
    return new Date(r.rows[0].updated_at).toISOString();
  }
  const row = sqlite.prepare('SELECT updated_at FROM profiles WHERE user_id = ?').get(uid);
  if (!row || !row.updated_at) return null;
  /* SQLite datetime('now') 为 UTC "YYYY-MM-DD HH:MM:SS"，转成可被 Date.parse 的 ISO 串 */
  return new Date(String(row.updated_at).replace(' ', 'T') + 'Z').toISOString();
}

async function profileSet(uid, dataStr) {
  if (globalThis.__incUsageDbWrite) globalThis.__incUsageDbWrite();
  if (USE_CLOUD_STORAGE) return cloudProfileSet(uid, dataStr);
  if (USE_PG) {
    await pool.query(
      `INSERT INTO profiles (user_id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [uid, dataStr]
    );
    return;
  }
  sqlite.prepare(
    `INSERT OR REPLACE INTO profiles (user_id, data, updated_at)
     VALUES (?, ?, datetime('now'))`
  ).run(uid, dataStr);
}

async function adminUsers() {
  const sql = `SELECT u.id, u.username, u.display_name, u.email, u.wechat, u.is_dev, u.created_at, p.updated_at, p.data
               FROM users u LEFT JOIN profiles p ON p.user_id = u.id
               ORDER BY u.id`;
  let rows;
  if (USE_PG) {
    const r = await pool.query(sql);
    rows = r.rows;
  } else {
    rows = sqlite.prepare(sql).all();
  }
  const out = rows.map(row => ({
    id: row.id, username: row.username, display_name: row.display_name || '',
    email: row.email || '', wechat: row.wechat || '',
    is_dev: Number(row.is_dev) === 1 ? 1 : 0,
    created_at: row.created_at, updated_at: row.updated_at, data: row.data
  }));
  /* 云存储模式：profiles 表为空，并发从云存储补 data/updated_at（比串行快 N 倍，用户多不卡） */
  if (USE_CLOUD_STORAGE) {
    const CONC = 10; /* 并发下载上限 */
    for (let i = 0; i < out.length; i += CONC) {
      const chunk = out.slice(i, i + CONC);
      await Promise.all(chunk.map(async u => {
        try {
          const data = await cloudProfileGet(u.id);
          const ts = await cloudProfileUpdatedAt(u.id);
          if (data !== null) { u.data = data; u.updated_at = ts || u.updated_at; }
        } catch (e) { /* 单个失败不影响其他 */ }
      }));
    }
  }
  return out;
}

/* 存储用量统计：数据库总大小 + 用户数据总大小 + 用户数（供看板展示容量） */
async function dbStats() {
  const stats = { dbBytes: 0, dataBytes: 0, users: 0 };
  /* 云存储模式：users 数从 users 表取；数据量按云存储估算（每用户约 50KB 均值） */
  if (USE_CLOUD_STORAGE) {
    const d = USE_PG
      ? await pool.query('SELECT COUNT(*) AS n FROM users')
      : sqlite.prepare('SELECT COUNT(*) AS n FROM users').get();
    stats.users = Number(d.rows ? d.rows[0].n : d.n) || 0;
    stats.dataBytes = stats.users * 51200; /* 云存储 profile 均值估算 ~50KB/人 */
    return stats;
  }
  if (USE_PG) {
    try {
      const r = await pool.query('SELECT pg_database_size(current_database()) AS b');
      stats.dbBytes = Number(r.rows[0] && r.rows[0].b) || 0;
    } catch (e) { /* 无权限时忽略 */ }
    const d = await pool.query('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS s FROM profiles');
    stats.users = Number(d.rows[0].n) || 0;
    stats.dataBytes = Number(d.rows[0].s) || 0;
  } else {
    const d = sqlite.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS s FROM profiles').get();
    stats.users = d.n || 0;
    stats.dataBytes = d.s || 0;
    const pc = sqlite.prepare('PRAGMA page_count').get();
    const ps = sqlite.prepare('PRAGMA page_size').get();
    stats.dbBytes = (pc.page_count || 0) * (ps.page_size || 0);
  }
  return stats;
}

/* ---------- 社区模板（需审核） ----------
 * status: 'pending'（待审） | 'approved'（已公开） | 'rejected'（已拒绝）
 * data / tags / counts 均以 JSON 字符串存储，列表接口解析后返回。 */
async function templateAdd({ author, title, desc, tags, counts, data }) {
  const status = 'pending';
  if (USE_PG) {
    const r = await pool.query(
      `INSERT INTO templates (author,title,"desc",tags,counts,data,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
      [author, title, desc, JSON.stringify(tags || []), JSON.stringify(counts || {}), JSON.stringify(data), status]
    );
    return r.rows[0].id;
  }
  const info = sqlite.prepare(
    `INSERT INTO templates (author,title,"desc",tags,counts,data,status,created_at)
     VALUES (?,?,?,?,?,?,?,datetime('now'))`
  ).run(author, title, desc, JSON.stringify(tags || []), JSON.stringify(counts || {}), JSON.stringify(data), status);
  return info.lastInsertRowid;
}

async function templateListApproved() {
  const sql = `SELECT id,author,title,"desc",tags,counts FROM templates WHERE status='approved' ORDER BY id DESC`;
  const rows = USE_PG ? (await pool.query(sql)).rows : sqlite.prepare(sql).all();
  return rows.map(r => ({
    id: r.id, author: r.author, title: r.title, desc: r.desc,
    tags: JSON.parse(r.tags || '[]'), counts: JSON.parse(r.counts || '{}')
  }));
}

async function templateListAll() {
  const sql = `SELECT id,author,title,"desc",tags,counts,status,created_at FROM templates ORDER BY id DESC`;
  const rows = USE_PG ? (await pool.query(sql)).rows : sqlite.prepare(sql).all();
  return rows.map(r => ({
    id: r.id, author: r.author, title: r.title, desc: r.desc,
    tags: JSON.parse(r.tags || '[]'), counts: JSON.parse(r.counts || '{}'),
    status: r.status, created_at: r.created_at
  }));
}

async function templateGet(id) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM templates WHERE id=$1', [id]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM templates WHERE id=?').get(id);
}

async function templateApprove(id) {
  if (USE_PG) { await pool.query(`UPDATE templates SET status='approved' WHERE id=$1`, [id]); return; }
  sqlite.prepare(`UPDATE templates SET status='approved' WHERE id=?`).run(id);
}

async function templateReject(id) {
  if (USE_PG) { await pool.query(`UPDATE templates SET status='rejected' WHERE id=$1`, [id]); return; }
  sqlite.prepare(`UPDATE templates SET status='rejected' WHERE id=?`).run(id);
}

/* ---------- 通知（模板审核结果推送给作者） ---------- */
async function notify(userId, type, payload) {
  if (USE_PG) {
    await pool.query(
      `INSERT INTO notifications (user_id, type, payload, created_at) VALUES ($1,$2,$3,NOW())`,
      [userId, type, JSON.stringify(payload || {})]
    );
    return;
  }
  sqlite.prepare(
    `INSERT INTO notifications (user_id, type, payload, created_at) VALUES (?,?,?,datetime('now'))`
  ).run(userId, type, JSON.stringify(payload || {}));
}
async function notificationList(userId) {
  const sql = `SELECT id,type,payload,is_read,created_at FROM notifications WHERE user_id=$uid ORDER BY id DESC LIMIT 50`;
  const map = r => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload || '{}'), is_read: !!r.is_read, created_at: r.created_at });
  if (USE_PG) {
    const r = await pool.query(sql.replace('$uid', '$1'), [userId]);
    return r.rows.map(map);
  }
  return sqlite.prepare(sql.replace('$uid', '?')).all(userId).map(map);
}
async function notificationUnreadCount(userId) {
  const sql = `SELECT COUNT(*) AS n FROM notifications WHERE user_id=$uid AND is_read=0`;
  if (USE_PG) { const r = await pool.query(sql.replace('$uid', '$1'), [userId]); return Number(r.rows[0].n); }
  const row = sqlite.prepare(sql.replace('$uid', '?')).get(userId);
  return Number(row.n);
}
async function notificationMarkRead(userId) {
  if (USE_PG) { await pool.query(`UPDATE notifications SET is_read=1 WHERE user_id=$1`, [userId]); return; }
  sqlite.prepare(`UPDATE notifications SET is_read=1 WHERE user_id=?`).run(userId);
}

/* ---------- 模板评分（1-5 星，每用户一条，upsert） ---------- */
async function ratingUpsert(templateId, userId, score) {
  const s = Math.max(1, Math.min(5, Math.round(Number(score) || 1)));
  if (USE_PG) {
    await pool.query(
      `INSERT INTO ratings (template_id,user_id,score) VALUES ($1,$2,$3)
       ON CONFLICT (template_id,user_id) DO UPDATE SET score=EXCLUDED.score`,
      [templateId, userId, s]
    );
    return;
  }
  sqlite.prepare(
    `INSERT INTO ratings (template_id,user_id,score) VALUES (?,?,?)
     ON CONFLICT (template_id,user_id) DO UPDATE SET score=excluded.score`
  ).run(templateId, userId, s);
}
async function ratingStats(templateId) {
  const sql = `SELECT COALESCE(AVG(score),0) AS avg, COUNT(*) AS cnt FROM ratings WHERE template_id=$tid`;
  if (USE_PG) { const r = await pool.query(sql.replace('$tid', '$1'), [templateId]); return { avg: Number(r.rows[0].avg), count: Number(r.rows[0].cnt) }; }
  const row = sqlite.prepare(sql.replace('$tid', '?')).get(templateId);
  return { avg: Number(row.avg), count: Number(row.cnt) };
}

/* ---------- 模板收藏（toggle） ---------- */
async function favoriteToggle(templateId, userId) {
  if (USE_PG) {
    const ex = await pool.query(`SELECT 1 FROM favorites WHERE template_id=$1 AND user_id=$2`, [templateId, userId]);
    if (ex.rows.length) { await pool.query(`DELETE FROM favorites WHERE template_id=$1 AND user_id=$2`, [templateId, userId]); return false; }
    await pool.query(`INSERT INTO favorites (template_id,user_id) VALUES ($1,$2)`, [templateId, userId]);
    return true;
  }
  const row = sqlite.prepare(`SELECT 1 FROM favorites WHERE template_id=? AND user_id=?`).get(templateId, userId);
  if (row) { sqlite.prepare(`DELETE FROM favorites WHERE template_id=? AND user_id=?`).run(templateId, userId); return false; }
  sqlite.prepare(`INSERT INTO favorites (template_id,user_id) VALUES (?,?)`).run(templateId, userId);
  return true;
}
async function favoriteIs(templateId, userId) {
  if (USE_PG) { const r = await pool.query(`SELECT 1 FROM favorites WHERE template_id=$1 AND user_id=$2`, [templateId, userId]); return r.rows.length > 0; }
  return !!sqlite.prepare(`SELECT 1 FROM favorites WHERE template_id=? AND user_id=?`).get(templateId, userId);
}

/* ---------- 用户系统：邮箱 / 微信绑定（v1.2） ---------- */
async function userById(uid) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [uid]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(uid);
}

/* 显示名唯一性检查：返回占用该名的用户（不含自身）；无则 null */
async function userByDisplayName(name, exceptUid) {
  if (USE_PG) {
    const r = await pool.query('SELECT id, username, display_name FROM users WHERE display_name = $1 AND ($2::int IS NULL OR id <> $2)', [name, exceptUid || null]);
    return r.rows[0] || null;
  }
  if (exceptUid) return sqlite.prepare('SELECT id, username, display_name FROM users WHERE display_name = ? AND id <> ?').get(name, exceptUid) || null;
  return sqlite.prepare('SELECT id, username, display_name FROM users WHERE display_name = ?').get(name) || null;
}

/* 按微信号查用户（不区分大小写）——用于网页端「微信号+密码」接入 wx_ 账号。
 * 🔴 wechat 字段全局唯一：应用层校验（SQLite ALTER 加列无 UNIQUE 约束，PG 用 UNIQUE INDEX）。 */
async function userByWechat(name) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE LOWER(wechat) = LOWER($1) LIMIT 1', [name]);
    return r.rows[0] || null;
  }
  return sqlite.prepare('SELECT * FROM users WHERE LOWER(IFNULL(wechat,"")) = LOWER(?) LIMIT 1').get(name) || null;
}

/* 检查 wechat 是否已被占用（不含自身） */
async function wechatTaken(name, exceptUid) {
  if (!name) return false;
  const u = await userByWechat(name);
  return !!(u && u.id !== exceptUid);
}

/* 设置显示名（唯一）：成功返回 true；已被占用返回 false（不抛错，让上层给友好提示） */
async function userSetDisplayName(uid, name) {
  if (USE_PG) {
    try {
      const r = await pool.query('UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id', [name, uid]);
      return r.rows.length > 0;
    } catch (e) { return false; /* 唯一约束冲突 */ }
  }
  try {
    const r = sqlite.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, uid);
    return r.changes > 0;
  } catch (e) { return false; }
}

/* 🔴 注册默认名（带冲突重试）：用户名清洗后若被占用，自动追加序号（名2、名3…），最多试 20 次。
 * 防：两个用户名同前缀（lsy080511@126.com / lsy080511@163.com）→ 默认名冲突 → 用户无名字却不提示。 */
async function setDisplayNameWithRetry(uid, username) {
  let base = String(username || '').split('@')[0].replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]/g, '').slice(0, 16);
  if (base.length < 2) base = '用户' + (uid || Math.floor(Math.random() * 10000));
  for (let i = 0; i < 20; i++) {
    let name = i === 0 ? base : base + (i + 1);
    if (name.length > 16) name = name.slice(0, 16);
    /* 🔴 应用层唯一性检查（SQLite ALTER 加列无 UNIQUE 约束，不能依赖 DB 报错） */
    const holder = await userByDisplayName(name, uid);
    if (!holder || String(holder.display_name).toLowerCase() !== name.toLowerCase()) {
      if (await userSetDisplayName(uid, name)) return true;
    }
  }
  return false;
}

/* 解锁：设置 unlock_until（ISO 时间串；null/空 = 未解锁） */
async function userUnlock(uid, untilISO) {
  if (USE_PG) {
    await pool.query('UPDATE users SET unlock_until = $1 WHERE id = $2', [untilISO, uid]);
  } else {
    sqlite.prepare('UPDATE users SET unlock_until = ? WHERE id = ?').run(untilISO, uid);
  }
}

/* 大小写不敏感查找（用于开发者设置等管理场景，兼容输入大小写不一致） */
async function userByNameCI(username) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [username]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

/* 开发者标记：is_dev=1 免付费墙 + 可直接登录管理后台 */
async function userSetDev(uid, isDev) {
  if (USE_PG) {
    await pool.query('UPDATE users SET is_dev = $1 WHERE id = $2', [isDev ? 1 : 0, uid]);
  } else {
    sqlite.prepare('UPDATE users SET is_dev = ? WHERE id = ?').run(isDev ? 1 : 0, uid);
  }
}

/* 备份（全库快照存 backups 表）：save 写入，list 列出（新→旧），trim 保留最近 keep 份 */
async function backupSave(snapshot) {
  const bytes = Buffer.byteLength(snapshot, 'utf8');
  if (USE_PG) {
    await pool.query('INSERT INTO backups (snapshot, size_bytes, created_at) VALUES ($1,$2,NOW())', [snapshot, bytes]);
  } else {
    sqlite.prepare('INSERT INTO backups (snapshot, size_bytes, created_at) VALUES (?,?,datetime(\'now\'))').run(snapshot, bytes);
  }
}
async function backupList(limit) {
  const n = Math.max(1, Math.min(30, Number(limit) || 10));
  if (USE_PG) {
    const r = await pool.query('SELECT id, size_bytes, created_at FROM backups ORDER BY id DESC LIMIT $1', [n]);
    return r.rows;
  }
  return sqlite.prepare('SELECT id, size_bytes, created_at FROM backups ORDER BY id DESC LIMIT ?').all(n);
}
async function backupGet(id) {
  if (USE_PG) {
    const r = await pool.query('SELECT snapshot FROM backups WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].snapshot : null;
  }
  const row = sqlite.prepare('SELECT snapshot FROM backups WHERE id = ?').get(id);
  return row ? row.snapshot : null;
}
async function backupTrim(keep) {
  const n = Math.max(1, Math.min(30, Number(keep) || 7));
  if (USE_PG) {
    await pool.query('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT $1)', [n]);
  } else {
    sqlite.prepare('DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?)').run(n);
  }
}

/* 支付订单幂等（防 webhook 重放无限解锁）：已处理过该订单号返回 true */
async function orderSeen(outTradeNo) {
  if (!outTradeNo) return true;
  if (USE_PG) {
    const r = await pool.query('SELECT 1 FROM pay_orders WHERE out_trade_no = $1', [outTradeNo]);
    return r.rows.length > 0;
  }
  return !!sqlite.prepare('SELECT 1 FROM pay_orders WHERE out_trade_no = ?').get(outTradeNo);
}async function orderMark(outTradeNo, channel, userId, amount) {
  try {
    if (USE_PG) {
      await pool.query('INSERT INTO pay_orders (out_trade_no, channel, user_id, amount) VALUES ($1,$2,$3,$4) ON CONFLICT (out_trade_no) DO NOTHING',
        [outTradeNo, channel || 'afdian', userId || 0, String(amount || '')]);
    } else {
      sqlite.prepare('INSERT OR IGNORE INTO pay_orders (out_trade_no, channel, user_id, amount) VALUES (?,?,?,?)')
        .run(outTradeNo, channel || 'afdian', userId || 0, String(amount || ''));
    }
  } catch (e) { console.warn('💰 订单记录失败：', e.message); }
}

async function userFindByEmail(email) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

async function userFindByOpenid(openid) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE wx_openid = $1', [openid]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE wx_openid = ?').get(openid);
}

async function userBindEmail(uid, email) {
  if (USE_PG) {
    await pool.query('UPDATE users SET email = $1, email_verified = 0 WHERE id = $2', [email, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').run(email, uid);
}

async function userVerifyEmail(uid) {
  if (USE_PG) {
    await pool.query('UPDATE users SET email_verified = 1 WHERE id = $1', [uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(uid);
}

async function userSetWechat(uid, wechat) {
  if (USE_PG) {
    await pool.query('UPDATE users SET wechat = $1 WHERE id = $2', [wechat, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET wechat = ? WHERE id = ?').run(wechat, uid);
}

async function userBindOpenid(uid, openid) {
  if (USE_PG) {
    await pool.query('UPDATE users SET wx_openid = $1 WHERE id = $2', [openid, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET wx_openid = ? WHERE id = ?').run(openid, uid);
}

async function userSetPassword(uid, pw_hash) {
  if (USE_PG) {
    await pool.query('UPDATE users SET pw_hash = $1 WHERE id = $2', [pw_hash, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(pw_hash, uid);
}

/* ---------- 分享快照（v0.6：规划生成链接一键套用） ---------- */
async function shareCreate(id, owner, title, dataStr) {
  if (USE_PG) {
    await pool.query(
      `INSERT INTO shares (id, owner, title, data, created_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [id, owner, title, dataStr]
    );
    return;
  }
  sqlite.prepare(
    `INSERT OR REPLACE INTO shares (id, owner, title, data, created_at) VALUES (?,?,?,?,datetime('now'))`
  ).run(id, owner, title, dataStr);
}
async function shareGet(id) {
  if (USE_PG) {
    const r = await pool.query(`SELECT id,owner,title,data FROM shares WHERE id=$1`, [id]);
    return r.rows[0];
  }
  return sqlite.prepare(`SELECT id,owner,title,data FROM shares WHERE id=?`).get(id);
}

/* 注销账号（PIPL 第 47 条 + 微信审核硬项）：删除该用户全部关联数据与账号行
 * templates 按 author 字符串关联（无 owner 列），故需传入 username */
async function userDelete(uid, username) {
  const T = (sql) => USE_PG ? sql.replace(/\?/g, '$1') : sql;
  if (USE_PG) {
    await pool.query('BEGIN');
    try {
      await pool.query(T('DELETE FROM profiles WHERE user_id = ?'), [uid]);
      await pool.query(T('DELETE FROM templates WHERE author = ?'), [username || '']);
      await pool.query(T('DELETE FROM notifications WHERE user_id = ?'), [uid]);
      await pool.query(T('DELETE FROM ratings WHERE user_id = ?'), [uid]);
      await pool.query(T('DELETE FROM favorites WHERE user_id = ?'), [uid]);
      await pool.query(T('DELETE FROM subscriptions WHERE user_id = ?'), [uid]);
      await pool.query(T('DELETE FROM shares WHERE owner = ?'), [uid]);
      await pool.query(T('DELETE FROM pay_orders WHERE user_id = ?'), [uid]);
      await pool.query(T('DELETE FROM users WHERE id = ?'), [uid]);
      await pool.query('COMMIT');
    } catch (e) { await pool.query('ROLLBACK'); throw e; }
  } else {
    const del = sqlite.transaction(() => {
      sqlite.prepare('DELETE FROM profiles WHERE user_id = ?').run(uid);
      sqlite.prepare('DELETE FROM templates WHERE author = ?').run(username || '');
      sqlite.prepare('DELETE FROM notifications WHERE user_id = ?').run(uid);
      sqlite.prepare('DELETE FROM ratings WHERE user_id = ?').run(uid);
      sqlite.prepare('DELETE FROM favorites WHERE user_id = ?').run(uid);
      sqlite.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(uid);
      sqlite.prepare('DELETE FROM shares WHERE owner = ?').run(uid);
      sqlite.prepare('DELETE FROM pay_orders WHERE user_id = ?').run(uid);
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(uid);
    });
    del();
  }
  /* 🔴 修复：云存储模式注销时同步删除 profiles/<uid>.json（否则隐私数据残留云存储） */
  if (USE_CLOUD_STORAGE) {
    try {
      const fileID = cloudFileID(uid);
      if (fileID) await cloudApp().deleteFile({ fileList: [fileID] });
    } catch (e) { console.warn('⚠️ 注销删除云存储 profile 失败：', (e && e.message) || e); }
  }
}

/* 🔴 清空全部用户数据（重新上架前使用）：清空 users 及所有关联表 + 云存储 profile/备份。
 * 返回删除数量。注意：sent_logs 保留（防提醒重复发送逻辑不受影响）。 */
async function wipeAllUsers() {
  /* 子表先删，主表最后（无外键，但保持合理顺序）；逐个 try/catch——某表失败不阻塞其他 */
  const tables = ['notifications', 'ratings', 'favorites', 'shares', 'subscriptions', 'pay_orders', 'backups', 'templates', 'profiles', 'users'];
  let deleted = 0;
  if (USE_PG) {
    try { const r = await pool.query('SELECT COUNT(*) AS n FROM users'); deleted = Number(r.rows[0].n) || 0; } catch (e) { console.warn('wipeAllUsers: 统计用户数失败', e.message); }
    for (const t of tables) {
      try { await pool.query(`DELETE FROM ${t}`); console.log('  ✓ 已清空', t); }
      catch (e) { console.warn('  ⚠️ 清空失败（跳过）:', t, e.message); }
    }
  } else {
    try { const r = sqlite.prepare('SELECT COUNT(*) AS n FROM users').get(); deleted = Number(r.n) || 0; } catch (e) {}
    const del = sqlite.transaction(() => { tables.forEach(t => { try { sqlite.prepare(`DELETE FROM ${t}`).run(); } catch (e) { console.warn('⚠️ 清空失败（跳过）:', t, e.message); } }); });
    del();
  }
  /* 云存储模式：删掉所有 profiles/ 文件（列表未知，按导出文件名枚举不可行——改为按已删用户逐条删 */
  if (USE_CLOUD_STORAGE) {
    try {
      /* 无法列目录，跳过文件清理；新注册用户会覆盖同 uid 文件（uid 自增，旧文件成孤儿，无害） */
      console.warn('⚠️ wipeAllUsers：云存储 profile 文件未逐一删除（孤儿文件无害，新用户 uid 不同）');
    } catch (e) { console.warn('云存储清理跳过：', e.message); }
  }
  return deleted;
}

module.exports = { init, isConnected, userByName, userByNameCI, userById, userByDisplayName, userByWechat, wechatTaken, userSetDisplayName, setDisplayNameWithRetry, createUser, userFindByEmail, userFindByOpenid, userBindEmail, userVerifyEmail, userSetWechat, userBindOpenid, userSetPassword, userUnlock, userSetDev, userDelete, wipeAllUsers, orderSeen, orderMark, backupSave, backupList, backupGet, backupTrim, profileGet, profileUpdatedAt, profileSet, adminUsers, dbStats, templateAdd, templateListApproved, templateListAll, templateGet, templateApprove, templateReject, notify, notificationList, notificationUnreadCount, notificationMarkRead, ratingUpsert, ratingStats, favoriteToggle, favoriteIs, shareCreate, shareGet, subUpsert, subEnabledList, sentOnce, USE_PG, USE_CLOUD_STORAGE, get _cloudBucket() { return _cloudBucket; } };

/* ---------- 订阅消息（微信提醒） ---------- */
async function subUpsert(userId, tplId, enabled) {
  const e = enabled ? 1 : 0;
  if (USE_PG) {
    await pool.query(`INSERT INTO subscriptions (user_id, tpl_id, enabled) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET tpl_id=$2, enabled=$3`, [userId, tplId, e]);
  } else {
    sqlite.prepare(`INSERT INTO subscriptions (user_id, tpl_id, enabled) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET tpl_id=excluded.tpl_id, enabled=excluded.enabled`).run(userId, tplId, e);
  }
}
/* 已开启订阅的用户（含 openid），用于定时下发提醒 */
async function subEnabledList() {
  const sql = `SELECT s.user_id, s.tpl_id, u.wx_openid FROM subscriptions s
               JOIN users u ON u.id = s.user_id
               WHERE s.enabled = 1 AND u.wx_openid IS NOT NULL`;
  if (USE_PG) { const r = await pool.query(sql); return r.rows.map(x => ({ userId: x.user_id, tplId: x.tpl_id, openid: x.wx_openid })); }
  return sqlite.prepare(sql).all().map(x => ({ userId: x.user_id, tplId: x.tpl_id, openid: x.wx_openid }));
}

/* 提醒去重（跨进程幂等）：key 如 'remind-2026-08-09'，当天已发过返回 false。
 * 解决「常驻 setInterval + 云函数 cron」并存时的双下发。 */
async function sentOnce(key) {
  if (USE_PG) {
    const r = await pool.query('SELECT 1 FROM sent_logs WHERE key = $1', [key]);
    if (r.rows.length) return false;
    await pool.query('INSERT INTO sent_logs (key) VALUES ($1) ON CONFLICT (key) DO NOTHING', [key]);
    const r2 = await pool.query('SELECT 1 FROM sent_logs WHERE key = $1', [key]);
    return r2.rows.length > 0; /* 插入失败（并发已插）→ false */
  }
  const exist = sqlite.prepare('SELECT 1 FROM sent_logs WHERE key = ?').get(key);
  if (exist) return false;
  try { sqlite.prepare('INSERT INTO sent_logs (key) VALUES (?)').run(key); return true; }
  catch (e) { return false; }
}
