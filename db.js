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

/* 云存储引擎启用条件：CLOUD_STORAGE=1 且 存在云凭证（TENCENTCLOUD_SECRETID 永久密钥，或 TENCENTCLOUD_SESSIONTOKEN 临时）。
 * 教训：容器型云托管不自动注入密钥，需手动配；无凭证时启用会连不上 → 视为未启用，本地开发安全。 */
/* 🔴 云凭证判定（方案B 教训）：云存储启用条件 = CLOUD_STORAGE=1 且 具备任一凭证来源：
 * ① 永久密钥（TENCENTCLOUD_SECRETID+SECRETKEY）
 * ② 云开发 API Key（CLOUDBASE_APIKEY）
 * ③ 云开发环境（TCB_ENV/SCF_NAMESPACE 存在）→ SDK getCredentialsOnDemand 动态获取容器临时凭证
 * 教训：CloudBase Run 容器自动注入临时凭证（SDK 动态获取），不要手动配永久密钥覆盖；
 * 删除永久密钥后不能因此禁用云存储（否则退化为 SQLite 临时盘，重启丢数据）。 */
const CLOUD_ENV = process.env.TCB_ENV || process.env.TCB_ENV_ID || process.env.SCF_NAMESPACE || '';
const HAS_CLOUD_CRED = !!(process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) || !!process.env.CLOUDBASE_APIKEY || !!CLOUD_ENV;
const USE_CLOUD_STORAGE = process.env.CLOUD_STORAGE === '1' && HAS_CLOUD_CRED;
/* 🔴 方案 B（全迁云存储）：云存储模式下彻底不用 PG——
 * users/profiles 走云存储；辅助表（模板/通知/评分/备份等低频可丢数据）走 SQLite 本地。
 * 关键：避免 USE_PG=true（DATABASE_URL 残留）但 PG 连不上 → 数据静默丢失。 */
const USE_PG = !!process.env.DATABASE_URL && !USE_CLOUD_STORAGE;
let _cloudApp = null; /* @cloudbase/node-sdk app 实例（惰性初始化） */
const _memCache = new Map(); /* 进程内存快照：{ 'profile:uid': {data,ts} } —— COS 故障时降级兜底 */

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
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      /* 🔴 云开发 API Key（CLOUDBASE_APIKEY 环境变量，JWT 格式）——
       * 云托管容器若无自动注入临时凭证（sessionToken=false），用 API Key 认证访问同账号云存储 */
      accessKey: process.env.CLOUDBASE_APIKEY || undefined
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
  const env = CLOUD_ENV || _cloudEnv; /* 🔴 CLOUD_ENV 空时用上传提取的真实 env */
  const bucket = _cloudBucket;
  if (env && bucket) return 'cloud://' + env + '.' + bucket + '/' + cloudFilePath(uid);
  return '';  /* 无法构造（尚未缓存）→ 走 getUploadMetadata 探测 */
}
async function ensureCloudBucket() {
  if (_cloudBucket) return true;
  try {
    const meta = await cloudApp().getUploadMetadata({ cloudPath: cloudFilePath('__probe') });
    const b = (meta && (meta.bucketId || meta.bucket)) || '';
    if (b) {
      _cloudBucket = b;
      /* 🔴 从 metadata 提取 env（envId 字段或返回里的 fileID 前缀） */
      if (!CLOUD_ENV && !_cloudEnv) {
        const e = (meta && (meta.envId || meta.env)) || '';
        if (e) _cloudEnv = e;
        else if (meta && meta.fileID && /^cloud:\/\//.test(meta.fileID)) {
          const mid = meta.fileID.replace('cloud://', '').split('/')[0];
          const dot = mid.indexOf('.');
          if (dot > 0) _cloudEnv = mid.slice(0, dot);
        }
      }
      return true;
    }
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
    /* 🔴 COS 直连读最新（绕过 CDN 缓存：downloadFile 走 CDN 会读到写前旧版） */
    const data = await cloudDownloadLatest(fileID);
    /* 写穿缓存：读成功后更新进程内存快照（COS 故障时降级兜底） */
    _memCache.set('profile:' + uid, { data, ts: Date.now() });
    return data;
  } catch (e) {
    /* 🔴 COS 读失败 → 尝试进程内存快照兜底（防 COS 短暂故障导致全站不可用） */
    const cached = _memCache.get('profile:' + uid);
    if (cached) {
      console.warn(`⚠️ COS 读取失败(${(e&&e.message)||e})，使用 ${Date.now()-cached.ts}ms 旧缓存: ${uid}`);
      return cached.data;
    }
    /* 无缓存 → 仍抛错（防 GET /api/data 误判为"无数据"用默认 bag 覆盖用户真实 profile） */
    console.error('⚠️ profile 读取失败（无缓存兜底，抛错防覆盖）:', (e && e.message) || e);
    throw e;
  }
}
async function cloudProfileGet(uid) {
  const raw = await cloudDownload(uid);
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j && j.data ? j.data : null; } catch (e) { return null; }
}
/* 探测 updatedAt：优先 getFileInfo（HEAD 请求，不下载 body，省流量/读次数）。
 * 文件内也存 updatedAt 作为兜底（getFileInfo 失败时）。 */
async function cloudProfileUpdatedAt(uid, preferFile) {
  /* 两种精度：
   * preferFile=true  → 读文件内毫秒级 updatedAt（PUT 乐观锁用，防同秒双写静默覆盖）
   * preferFile=false → getFileInfo 秒级（meta 探测用，省全量下载流量；秒级误差只多拉一次不丢数据） */
  if (preferFile) {
    const raw = await cloudDownload(uid);
    if (raw) {
      try { const j = JSON.parse(raw); if (j && j.updatedAt) { const d = new Date(j.updatedAt); if (!isNaN(d.getTime())) return d.toISOString(); } } catch (e) { /* 兜底 */ }
    }
  }
  try {
    const fileID = cloudFileID(uid);
    if (fileID) {
      const fi = await cloudApp().getFileInfo({ fileList: [fileID] });
      const item = (fi && fi.fileList && fi.fileList[0]) || {};
      if (cloudOk(item) && item.lastModified) {
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
  /* 写穿缓存：上传成功后更新内存快照（读路径 COS 故障时可降级返回） */
  _memCache.set('profile:' + uid, { data: dataStr, ts: Date.now() });
  /* 从上传返回的权威 fileID 提取 envId.bucketId 缓存（cloud://<env>.<bucket>/<path>） */
  if (res && res.fileID && /^cloud:\/\//.test(res.fileID)) {
    try {
      const mid = res.fileID.replace('cloud://', '').split('/')[0]; /* envId.bucketId */
      const dot = mid.indexOf('.');
      if (dot > 0) {
        const e = mid.slice(0, dot), b = mid.slice(dot + 1);
        if (e !== _cloudEnv || b !== _cloudBucket) {
          _cloudEnv = e; /* 🔴 修复：缓存真实 env（线上 TCB_ENV 可能为空，从上传返回的 fileID 提取权威值） */
          _cloudBucket = b;
          _cloudMetaDirty = true; /* 🔴 只在变化时标记——避免每次 profileSet 都上传 meta.json（写放大 2x） */
        }
      }
      /* 🔴 持久化 meta.json（跨重启/多实例恢复 env/bucket）——仅首次/变化时上传 */
      if (_cloudMetaDirty) await _cloudSaveMeta();
    } catch (e) { /* 忽略 */ }
  }
}
let _cloudEnv = ''; /* 从上传返回 fileID 提取的真实 env（CLOUD_ENV 空时兜底） */
let _cloudMetaDirty = false; /* meta.json 需要上传（env/bucket 变化才置脏） */
const CLOUD_META_FILE = 'meta.json'; /* 云存储元信息（env/bucket）——重启后也能构造 fileID */

/* 🔴 持久化 env/bucket：写成功后将 meta.json 上传（重启读回，解决 TCB_ENV 空导致 fileID 构造失败） */
async function _cloudSaveMeta() {
  try {
    if (!_cloudEnv && !_cloudBucket) return;
    const meta = { env: _cloudEnv, bucket: _cloudBucket, at: Date.now() };
    const res = await cloudApp().uploadFile({ cloudPath: CLOUD_META_FILE, fileContent: Buffer.from(JSON.stringify(meta), 'utf8') });
    if (!res) return;
    if (res.code && res.code !== 'SUCCESS' && res.code !== 0) return;
    if (res.fileID && /^cloud:\/\//.test(res.fileID)) {
      const mid = res.fileID.replace('cloud://', '').split('/')[0];
      const dot = mid.indexOf('.');
      if (dot > 0 && !_cloudEnv) _cloudEnv = mid.slice(0, dot);
      if (dot > 0 && !_cloudBucket) _cloudBucket = mid.slice(dot + 1);
    }
  } catch (e) { console.warn('⚠️ meta.json 写入失败:', (e && e.message) || e); }
}
async function _cloudLoadMeta() {
  try {
    /* 🔴 核心方案：getUploadMetadata 探测（不需要 env，返回 data.fileId 含真实 env/bucket） */
    if (!_cloudEnv || !_cloudBucket) {
      const meta = await cloudApp().getUploadMetadata({ cloudPath: cloudFilePath('__probe') });
      const data = meta && meta.data ? meta.data : meta;
      const fid = (data && (data.fileId || data.fileID)) || '';
      /* fileId 形如 cloud://<env>.<bucket>/<path> 或 <env>.<bucket>/<path> */
      const mid = fid.replace('cloud://', '').split('/')[0] || '';
      const dot = mid.indexOf('.');
      if (dot > 0) {
        if (!_cloudEnv) _cloudEnv = mid.slice(0, dot);
        if (!_cloudBucket) _cloudBucket = mid.slice(dot + 1);
      }
      const b = (data && (data.bucketId || data.bucket)) || '';
      if (b && !_cloudBucket) _cloudBucket = b;
    }
  } catch (e) { /* 忽略 */ }
}

/* ================= users 表云存储层（方案 B：全迁云存储，弃 PG/SQLite） =================
 * users 表存单个云存储文件 users.json：{"seq": <自增id>, "users": [ {id, username, pw_hash, ...} ]}
 * - 内存缓存 _cloudUsers（减少读次数）；写时串行队列（防并发覆盖，单实例够用）
 * - 所有 user* 函数在 USE_CLOUD_STORAGE 时走这里 */
const CLOUD_USERS_FILE = 'users.json';
let _cloudUsers = null;      /* {seq, users[]} 缓存 */
let _cloudUsersLoading = null; /* 并发读去重 */
let _cloudUsersWriteQ = Promise.resolve(); /* 串行写队列 */
let _cloudIdx = null;        /* 🔴 索引缓存：{byNameCI: Map<lowerName, idx>, byId: Map<id, idx>} —— 避免每次查询全量扫 */

function _rebuildCloudIdx() {
  if (!_cloudUsers) { _cloudIdx = null; return; }
  const byNameCI = new Map(), byId = new Map();
  _cloudUsers.users.forEach((u, i) => {
    byId.set(Number(u.id), i);
    byNameCI.set(String(u.username).toLowerCase(), i);
  });
  _cloudIdx = { byNameCI, byId };
}
function _cloudIdxGet() {
  if (!_cloudIdx || !_cloudUsers) _rebuildCloudIdx();
  return _cloudIdx;
}

async function cloudUsersLoad() {
  if (_cloudUsers) return _cloudUsers;
  if (_cloudUsersLoading) return _cloudUsersLoading;
  _cloudUsersLoading = (async () => {
    try {
      let fileID = cloudFileID0(CLOUD_USERS_FILE);
      if (!fileID) {
        if (!(await ensureCloudBucket())) throw new Error('云存储桶未就绪');
        fileID = cloudFileID0(CLOUD_USERS_FILE);
        if (!fileID) throw new Error('云存储 fileID 构造失败');
      }
      const raw = await cloudDownloadLatest(fileID);
      if (raw) {
        const j = JSON.parse(raw);
        if (j && Array.isArray(j.users)) { _cloudUsers = { seq: Number(j.seq) || 0, users: j.users }; _rebuildCloudIdx(); return _cloudUsers; }
      }
      /* 文件不存在或损坏 → 初始化为空 */
      _cloudUsers = { seq: 0, users: [] };
      _rebuildCloudIdx();
      return _cloudUsers;
    } catch (e) {
      /* 🔴 读失败必须抛——若置空，随后任意一次写（注册/改名/绑定）会用空缓存覆盖 users.json 清空全部账号 */
      console.error('⚠️ users.json 读取失败（抛错防覆盖）:', (e && e.message) || e);
      throw e;
    } finally { _cloudUsersLoading = null; }
  })();
  return _cloudUsersLoading;
}

/* 🔴 云存储返回判定兼容：真实 SDK downloadFile 返回 {fileContent}（code=undefined），
     * 旧代码 r.code !== 'SUCCESS' 恒真 → 读取永远失败（写入成功但读回空——数据丢失假象的根因）。
     * mock 返回 code:'SUCCESS'，需两者都兼容。 */
function cloudOk(r) {
  if (!r) return false;
  const c = r.code;
  return c === undefined || c === null || c === 'SUCCESS' || c === 0;
}
/* 🔴 读最新文件内容：getTempFileURL+COS_URL（COS 直连签名 URL，每次不同 → 绕过 CDN 缓存）。
     * 旧 SDK downloadFile 走 CDN 域名，写入后立即读回旧版（缓存 TTL ~1-2 分钟）——数据丢失假象根因。 */
async function cloudDownloadLatest(fileID) {
  try {
    const r = await cloudApp().getTempFileURL({ fileList: [{ fileID, maxAge: 60, urlType: 'COS_URL' }] });
    const item = r && r.fileList && r.fileList[0];
    if (!item) throw new Error('云存储读失败：无响应');
    /* getTempFileURL 返回错误码 = 读失败（凭证/权限/网络）→ 抛，防上层误判为空覆盖 */
    if (item.code && item.code !== 'SUCCESS' && item.code !== 0) {
      /* 🔴 文件不存在（getTempFileURL 返回 STORAGE_FILE_NONEXIST 等错误码，非 HTTP 404）→ 正常返回 null */
      if (/NONEXIST|NOT_FOUND|NOEXIST|NOTFOUND/i.test(String(item.code))) return null;
      throw new Error('云存储读失败: ' + (item.code || ''));
    }
    const url = item.download_url || item.tempFileURL || '';
    if (!url) throw new Error('云存储读失败：无下载地址');
    const resp = await fetch(url);
    if (resp.status === 404) return null; /* 🔴 文件不存在（新用户/首次）→ 正常返回 null */
    if (!resp.ok) throw new Error('云存储读失败: HTTP ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    const c = buf.toString('utf8');
    return (c === undefined || c === null || c === '') ? null : c;
  } catch (e) { throw e; } /* 🔴 异常向上抛（不吞）——宁可 500 也不让上层误判为空去覆盖真实数据 */
}
function cloudFileID0(path) {
  const env = CLOUD_ENV || _cloudEnv; /* 🔴 CLOUD_ENV 空时用上传提取的真实 env */
  const bucket = _cloudBucket;
  if (env && bucket) return 'cloud://' + env + '.' + bucket + '/' + path;
  return '';
}

async function cloudUsersSave() {
  if (!_cloudUsers) return true;
  _rebuildCloudIdx();
  const snapshot = JSON.stringify(_cloudUsers);
  /* 串行化写，防并发覆盖（注册/改名等高频写）。
   * 🔴 失败返回 false（不再静默假成功）——调用方（createUser/cloudUserSet）抛错让上层感知，
   * 否则注册/改名"显示成功"但重启后账号消失（写入其实没落盘） */
  const p = _cloudUsersWriteQ.then(async () => {
    const res = await cloudApp().uploadFile({ cloudPath: CLOUD_USERS_FILE, fileContent: Buffer.from(snapshot, 'utf8') });
    if (!res) throw new Error('users.json 上传无响应');
    if (res.code && res.code !== 'SUCCESS' && res.code !== 0) throw new Error('users.json 上传失败: ' + (res.message || res.code));
    return true;
  }).catch(e => { console.warn('⚠️ users.json 写入失败:', (e && e.message) || e); return false; });
  /* 队列不断链：写失败也允许下一次写继续排队 */
  _cloudUsersWriteQ = p.catch(() => {});
  return p;
}

async function cloudUserById(uid) {
  const u = await cloudUsersLoad();
  const idx = _cloudIdxGet().byId.get(Number(uid));
  return idx !== undefined ? u.users[idx] : null;
}
async function cloudUserByName(username) {
  const u = await cloudUsersLoad();
  const idx = _cloudIdxGet().byNameCI.get(String(username).toLowerCase());
  return idx !== undefined && u.users[idx].username === username ? u.users[idx] : null;
}
async function cloudUserByNameCI(username) {
  const u = await cloudUsersLoad();
  const idx = _cloudIdxGet().byNameCI.get(String(username).toLowerCase());
  return idx !== undefined ? u.users[idx] : null;
}
async function cloudUserByOpenid(openid) {
  if (!openid) return null;
  const u = await cloudUsersLoad();
  return u.users.find(x => x.wx_openid === openid) || null;
}
async function cloudUserByEmail(email) {
  if (!email) return null;
  const u = await cloudUsersLoad();
  const lo = String(email).toLowerCase();
  return u.users.find(x => x.email && String(x.email).toLowerCase() === lo) || null;
}
async function cloudUserByWechat(name) {
  if (!name) return null;
  const u = await cloudUsersLoad();
  const lo = String(name).toLowerCase();
  return u.users.find(x => x.wechat && String(x.wechat).toLowerCase() === lo) || null;
}
async function cloudUserByDisplayName(name, exceptUid) {
  const u = await cloudUsersLoad();
  const lo = String(name).toLowerCase();
  return u.users.find(x => x.display_name && String(x.display_name).toLowerCase() === lo && Number(x.id) !== Number(exceptUid || 0)) || null;
}
async function cloudCreateUser(username, pw_hash) {
  const u = await cloudUsersLoad();
  /* 🔴 唯一性检查（并发安全）：username 大小写不敏感唯一；openid 唯一。
   * 云存储无 DB 约束，靠这里应用层拦截——调用方（register/wx login）也已先查重，
   * 但并发时两个请求可能同时通过查重，这里在写队列内二次拦截。 */
  const lo = String(username).toLowerCase();
  if (u.users.some(x => String(x.username).toLowerCase() === lo)) return 0; /* 0 = 冲突 */
  u.seq += 1;
  const id = u.seq;
  u.users.push({ id, username, pw_hash, email: null, email_verified: 0, wechat: null, wx_openid: null, display_name: null, unlock_until: null, is_dev: 0, pw_set: 0, orphaned: 0, created_at: new Date().toISOString() });
  const ok = await cloudUsersSave();
  if (!ok) throw new Error('用户数据保存失败，请重试');
  return id;
}
async function cloudUserSet(uid, fields) {
  const u = await cloudUsersLoad();
  const x = u.users.find(v => Number(v.id) === Number(uid));
  if (!x) return false;
  Object.assign(x, fields);
  const ok = await cloudUsersSave();
  if (!ok) throw new Error('用户数据保存失败，请重试');
  return true;
}
async function cloudUserAll() {
  const u = await cloudUsersLoad();
  return u.users.slice();
}
async function cloudWipeUsers() {
  const n = _cloudUsers ? _cloudUsers.users.length : 0;
  _cloudUsers = { seq: 0, users: [] };
  const ok = await cloudUsersSave();
  if (!ok) throw new Error('用户数据保存失败（wipe 未落盘）');
  return n;
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
      category   TEXT NOT NULL DEFAULT '',
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
      pw_set         INTEGER NOT NULL DEFAULT 0,
      orphaned       INTEGER NOT NULL DEFAULT 0,
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
      category   TEXT NOT NULL DEFAULT '',
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
  /* 🔴 方案 B：云存储模式——users/profiles 走云存储，辅助表走本地 SQLite（低频可丢数据） */
  if (USE_CLOUD_STORAGE) {
    try {
      if (!sqlite) {
        const Database = require('better-sqlite3');
        sqlite = new Database(path.join(__dirname, 'data.db'));
      }
      const tables = Object.values(SCHEMA_SQLITE);
      sqlite.exec(tables.join(';'));
      connected = true;
      /* 🔴 预载 env/bucket 元信息（TCB_ENV 空时也能构造 fileID 读写）——不阻塞，失败忽略 */
      try { await _cloudLoadMeta(); } catch (e) { /* 忽略 */ }
      console.log('✅ 数据库：云存储模式（users/profiles 存云存储，辅助表本地 SQLite）');
    } catch (e) {
      console.warn('⚠️ 云存储模式 SQLite 初始化失败:', (e && e.message) || e);
      connected = true; /* 即使辅助表失败也不阻塞核心云存储功能 */
      console.log('✅ 数据库：云存储模式（users/profiles 存云存储，辅助表降级）');
    }
    return;
  }
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
      for (const col of ['email TEXT', 'email_verified INTEGER NOT NULL DEFAULT 0', 'wechat TEXT', 'wx_openid TEXT', 'unlock_until TEXT', 'is_dev INTEGER NOT NULL DEFAULT 0', 'display_name TEXT', 'pw_set INTEGER NOT NULL DEFAULT 0', 'orphaned INTEGER NOT NULL DEFAULT 0']) {
        const name = col.split(' ')[0];
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name} ${col.slice(name.length).trim()}`);
      }
      /* 🔴 wechat 唯一索引（应用层 + DB 双重保障，让「微信号+密码」能定位 wx_ 账号）
       * 用 LOWER() 实现大小写不敏感的唯一性（微信号不区分大小写） */
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_wechat_unique ON users (LOWER(wechat)) WHERE wechat IS NOT NULL AND wechat <> ''`);
      /* templates 表 category 迁移（2026-08-09） */
      await pool.query(`ALTER TABLE templates ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT ''`);
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
    if (!cols.includes('pw_set')) sqlite.exec(`ALTER TABLE users ADD COLUMN pw_set INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('orphaned')) sqlite.exec(`ALTER TABLE users ADD COLUMN orphaned INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('is_dev')) sqlite.exec(`ALTER TABLE users ADD COLUMN is_dev INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('display_name')) sqlite.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
    /* templates 表 category 迁移（2026-08-09） */
    const tplCols = sqlite.prepare('PRAGMA table_info(templates)').all().map(c => c.name);
    if (!tplCols.includes('category')) sqlite.exec(`ALTER TABLE templates ADD COLUMN category TEXT NOT NULL DEFAULT ''`);
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
  if (USE_CLOUD_STORAGE) return cloudUserByName(username);
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

async function createUser(username, pw_hash) {
  if (USE_CLOUD_STORAGE) return cloudCreateUser(username, pw_hash);
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
async function profileUpdatedAt(uid, preferFile) {
  if (globalThis.__incUsageDbRead) globalThis.__incUsageDbRead();
  if (USE_CLOUD_STORAGE) return cloudProfileUpdatedAt(uid, preferFile);
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
  /* 🔴 云存储模式（方案 B）：users 表也在云存储，直接读云存储 users.json + 并发补 profile */
  if (USE_CLOUD_STORAGE) {
    const users = await cloudUserAll();
    const out = users.map(u => ({
      id: u.id, username: u.username, display_name: u.display_name || '',
      email: u.email || '', wechat: u.wechat || '',
      is_dev: Number(u.is_dev) === 1 ? 1 : 0,
      created_at: u.created_at, updated_at: null, data: null
    }));
    const CONC = 10;
    for (let i = 0; i < out.length; i += CONC) {
      const chunk = out.slice(i, i + CONC);
      await Promise.all(chunk.map(async u => {
        try {
          const data = await cloudProfileGet(u.id);
          const ts = await cloudProfileUpdatedAt(u.id, false);
          if (data !== null) { u.data = data; u.updated_at = ts || u.updated_at; }
        } catch (e) { /* 单个失败不影响其他 */ }
      }));
    }
    return out;
  }
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
  return out;
}

/* 存储用量统计：数据库总大小 + 用户数据总大小 + 用户数（供看板展示容量） */
async function dbStats() {
  const stats = { dbBytes: 0, dataBytes: 0, users: 0 };
  /* 云存储模式：users 数从 users 表取；数据量按云存储估算（每用户约 50KB 均值） */
  if (USE_CLOUD_STORAGE) {
    const users = await cloudUserAll();
    stats.users = users.length;
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
async function templateAdd({ author, title, desc, tags, counts, data, category }) {
  const cat = category || '';
  const status = 'pending';
  /* 🔴 云存储模式：templates.json 持久（重启不丢模板） */
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    t.seq = (Number(t.seq) || 0) + 1;
    if (!Array.isArray(t.list)) t.list = [];
    t.list.push({
      id: t.seq, author, title, desc, tags: tags || [], counts: counts || {},
      category: cat, /* 🔴 社区模板分类（减脂/增肌/学习/效率等） */
      data: (typeof data === 'string') ? data : JSON.stringify(data || {}),
      status, created_at: new Date().toISOString()
    });
    await cloudTemplatesSave();
    return t.seq;
  }
  if (USE_PG) {
    const r = await pool.query(
      `INSERT INTO templates (author,title,"desc",tags,counts,category,data,status,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
      [author, title, desc, JSON.stringify(tags || []), JSON.stringify(counts || {}), cat, JSON.stringify(data), status]
    );
    return r.rows[0].id;
  }
  const info = sqlite.prepare(
    `INSERT INTO templates (author,title,"desc",tags,counts,category,data,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
  ).run(author, title, desc, JSON.stringify(tags || []), JSON.stringify(counts || {}), cat, JSON.stringify(data), status);
  return info.lastInsertRowid;
}

async function templateListApproved() {
  /* 🔴 云存储模式：从 templates.json 过滤 */
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    return (t.list || []).filter(x => x.status === 'approved').sort((a, b) => b.id - a.id).map(x => ({
      id: x.id, author: x.author, title: x.title, desc: x.desc,
      tags: x.tags || [], counts: x.counts || {}, category: x.category || ''
    }));
  }
  const sql = `SELECT id,author,title,"desc",tags,counts,category FROM templates WHERE status='approved' ORDER BY id DESC`;
  const rows = USE_PG ? (await pool.query(sql)).rows : sqlite.prepare(sql).all();
  return rows.map(r => ({
    id: r.id, author: r.author, title: r.title, desc: r.desc,
    tags: JSON.parse(r.tags || '[]'), counts: JSON.parse(r.counts || '{}'), category: r.category || ''
  }));
}

async function templateListAll() {
  /* 🔴 云存储模式：从 templates.json */
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    return (t.list || []).slice().sort((a, b) => b.id - a.id).map(x => ({
      id: x.id, author: x.author, title: x.title, desc: x.desc,
      tags: x.tags || [], counts: x.counts || {},
      status: x.status, created_at: x.created_at
    }));
  }
  const sql = `SELECT id,author,title,"desc",tags,counts,status,created_at FROM templates ORDER BY id DESC`;
  const rows = USE_PG ? (await pool.query(sql)).rows : sqlite.prepare(sql).all();
  return rows.map(r => ({
    id: r.id, author: r.author, title: r.title, desc: r.desc,
    tags: JSON.parse(r.tags || '[]'), counts: JSON.parse(r.counts || '{}'),
    status: r.status, created_at: r.created_at
  }));
}

async function templateGet(id) {
  /* 🔴 云存储模式：从 templates.json 查 */
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    return (t.list || []).find(x => Number(x.id) === Number(id)) || null;
  }
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM templates WHERE id=$1', [id]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM templates WHERE id=?').get(id);
}

async function templateApprove(id) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    const x = (t.list || []).find(y => Number(y.id) === Number(id));
    if (x) { x.status = 'approved'; await cloudTemplatesSave(); }
    return;
  }
  if (USE_PG) { await pool.query(`UPDATE templates SET status='approved' WHERE id=$1`, [id]); return; }
  sqlite.prepare(`UPDATE templates SET status='approved' WHERE id=?`).run(id);
}

async function templateReject(id) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    const x = (t.list || []).find(y => Number(y.id) === Number(id));
    if (x) { x.status = 'rejected'; await cloudTemplatesSave(); }
    return;
  }
  if (USE_PG) { await pool.query(`UPDATE templates SET status='rejected' WHERE id=$1`, [id]); return; }
  sqlite.prepare(`UPDATE templates SET status='rejected' WHERE id=?`).run(id);
}

async function templateUpdate(id, { title, desc, tags, category, data }) {
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    const x = (t.list || []).find(y => Number(y.id) === Number(id));
    if (!x) throw new Error('模板不存在');
    if (title !== undefined) x.title = title;
    if (desc !== undefined) x.desc = desc;
    if (tags !== undefined) x.tags = tags;
    if (category !== undefined) x.category = category;
    if (data !== undefined) x.data = (typeof data === 'string') ? data : JSON.stringify(data || {});
    await cloudTemplatesSave();
    return;
  }
  const fields = [], values = [], idx = [];
  if (title !== undefined) { fields.push('title'); values.push(title); idx.push(fields.length); }
  if (desc !== undefined) { fields.push('"desc"'); values.push(desc); idx.push(fields.length); }
  if (tags !== undefined) { fields.push('tags'); values.push(JSON.stringify(tags)); idx.push(fields.length); }
  if (category !== undefined) { fields.push('category'); values.push(category); idx.push(fields.length); }
  if (data !== undefined) { fields.push('data'); values.push(JSON.stringify(data)); idx.push(fields.length); }
  if (!fields.length) return;
  const set = fields.map((f, i) => `${f}=$${i+1}`).join(',');
  values.push(id);
  if (USE_PG) { await pool.query(`UPDATE templates SET ${set} WHERE id=$${values.length}`, values); return; }
  sqlite.prepare(`UPDATE templates SET ${set} WHERE id=?`).run(...values);
}

async function templateDelete(id) {
  if (USE_CLOUD_STORAGE) {
    const t = await cloudTemplatesLoad();
    t.list = (t.list || []).filter(y => Number(y.id) !== Number(id));
    await cloudTemplatesSave();
    return;
  }
  if (USE_PG) { await pool.query(`DELETE FROM templates WHERE id=$1`, [id]); return; }
  sqlite.prepare(`DELETE FROM templates WHERE id=?`).run(id);
}

/* ---------- 通知（模板审核结果推送给作者） ---------- */
async function notify(userId, type, payload) {
  /* 🔴 云存储模式：notifications.json 持久 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('notifications');
    t.seq = (Number(t.seq) || 0) + 1;
    t.rows.push({ id: t.seq, user_id: userId, type, payload: payload || {}, is_read: 0, created_at: new Date().toISOString() });
    return _cloudTableSave('notifications');
  }
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
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('notifications');
    return t.rows.filter(r => r.user_id === userId).sort((a, b) => b.id - a.id).slice(0, 50)
      .map(r => ({ id: r.id, type: r.type, payload: r.payload || {}, is_read: !!r.is_read, created_at: r.created_at }));
  }
  const sql = `SELECT id,type,payload,is_read,created_at FROM notifications WHERE user_id=$uid ORDER BY id DESC LIMIT 50`;
  const map = r => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload || '{}'), is_read: !!r.is_read, created_at: r.created_at });
  if (USE_PG) {
    const r = await pool.query(sql.replace('$uid', '$1'), [userId]);
    return r.rows.map(map);
  }
  return sqlite.prepare(sql.replace('$uid', '?')).all(userId).map(map);
}
async function notificationUnreadCount(userId) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('notifications');
    return t.rows.filter(r => r.user_id === userId && !r.is_read).length;
  }
  const sql = `SELECT COUNT(*) AS n FROM notifications WHERE user_id=$uid AND is_read=0`;
  if (USE_PG) { const r = await pool.query(sql.replace('$uid', '$1'), [userId]); return Number(r.rows[0].n); }
  const row = sqlite.prepare(sql.replace('$uid', '?')).get(userId);
  return Number(row.n);
}
async function notificationMarkRead(userId) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('notifications');
    let changed = false;
    t.rows.forEach(r => { if (r.user_id === userId && !r.is_read) { r.is_read = 1; changed = true; } });
    if (changed) return _cloudTableSave('notifications');
    return;
  }
  if (USE_PG) { await pool.query(`UPDATE notifications SET is_read=1 WHERE user_id=$1`, [userId]); return; }
  sqlite.prepare(`UPDATE notifications SET is_read=1 WHERE user_id=?`).run(userId);
}

/* ---------- 模板评分（1-5 星，每用户一条，upsert） ---------- */
async function ratingUpsert(templateId, userId, score) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('ratings');
    const sc = Math.max(1, Math.min(5, Math.round(Number(score) || 1)));
    const ex = t.rows.find(r => r.template_id === templateId && r.user_id === userId);
    if (ex) ex.score = sc;
    else t.rows.push({ template_id: templateId, user_id: userId, score: sc });
    return _cloudTableSave('ratings');
  }
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
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('ratings');
    const rs = t.rows.filter(r => r.template_id === templateId);
    if (!rs.length) return { avg: 0, count: 0 };
    return { avg: rs.reduce((sum, r) => sum + (Number(r.score) || 0), 0) / rs.length, count: rs.length };
  }
  const sql = `SELECT COALESCE(AVG(score),0) AS avg, COUNT(*) AS cnt FROM ratings WHERE template_id=$tid`;
  if (USE_PG) { const r = await pool.query(sql.replace('$tid', '$1'), [templateId]); return { avg: Number(r.rows[0].avg), count: Number(r.rows[0].cnt) }; }
  const row = sqlite.prepare(sql.replace('$tid', '?')).get(templateId);
  return { avg: Number(row.avg), count: Number(row.cnt) };
}

/* ---------- 模板收藏（toggle） ---------- */
async function favoriteToggle(templateId, userId) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('favorites');
    const idx = t.rows.findIndex(r => r.template_id === templateId && r.user_id === userId);
    if (idx >= 0) { t.rows.splice(idx, 1); await _cloudTableSave('favorites'); return false; }
    t.rows.push({ template_id: templateId, user_id: userId });
    await _cloudTableSave('favorites');
    return true;
  }
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
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('favorites');
    return t.rows.some(r => r.template_id === templateId && r.user_id === userId);
  }
  if (USE_PG) { const r = await pool.query(`SELECT 1 FROM favorites WHERE template_id=$1 AND user_id=$2`, [templateId, userId]); return r.rows.length > 0; }
  return !!sqlite.prepare(`SELECT 1 FROM favorites WHERE template_id=? AND user_id=?`).get(templateId, userId);
}

/* ---------- 用户系统：邮箱 / 微信绑定（v1.2） ---------- */
async function userById(uid) {
  if (USE_CLOUD_STORAGE) return cloudUserById(uid);
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [uid]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(uid);
}

/* 显示名唯一性检查：返回占用该名的用户（不含自身）；无则 null */
async function userByDisplayName(name, exceptUid) {
  if (USE_CLOUD_STORAGE) return cloudUserByDisplayName(name, exceptUid);
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
  if (USE_CLOUD_STORAGE) return cloudUserByWechat(name);
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE LOWER(wechat) = LOWER($1) LIMIT 1', [name]);
    return r.rows[0] || null;
  }
  return sqlite.prepare("SELECT * FROM users WHERE LOWER(IFNULL(wechat,'')) = LOWER(?) LIMIT 1").get(name) || null;
}

/* 检查 wechat 是否已被占用（不含自身） */
async function wechatTaken(name, exceptUid) {
  if (!name) return false;
  const u = await userByWechat(name);
  return !!(u && u.id !== exceptUid);
}

/* 设置显示名（唯一）：成功返回 true；已被占用返回 false（不抛错，让上层给友好提示） */
async function userSetDisplayName(uid, name) {
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { display_name: name || null });
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
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { unlock_until: untilISO || null });
  if (USE_PG) {
    await pool.query('UPDATE users SET unlock_until = $1 WHERE id = $2', [untilISO, uid]);
  } else {
    sqlite.prepare('UPDATE users SET unlock_until = ? WHERE id = ?').run(untilISO, uid);
  }
}

/* 大小写不敏感查找（用于开发者设置等管理场景，兼容输入大小写不一致） */
async function userByNameCI(username) {
  if (USE_CLOUD_STORAGE) return cloudUserByNameCI(username);
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1', [username]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
}

/* 开发者标记：is_dev=1 免付费墙 + 可直接登录管理后台 */
async function userSetDev(uid, isDev) {
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { is_dev: isDev ? 1 : 0 });
  if (USE_PG) {
    await pool.query('UPDATE users SET is_dev = $1 WHERE id = $2', [isDev ? 1 : 0, uid]);
  } else {
    sqlite.prepare('UPDATE users SET is_dev = ? WHERE id = ?').run(isDev ? 1 : 0, uid);
  }
}

/* 备份（全库快照存 backups 表）：save 写入，list 列出（新→旧），trim 保留最近 keep 份 */
async function backupSave(snapshot) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('backups');
    t.seq = (Number(t.seq) || 0) + 1;
    t.rows.push({ id: t.seq, snapshot, size_bytes: Buffer.byteLength(snapshot, 'utf8'), created_at: new Date().toISOString() });
    return _cloudTableSave('backups');
  }
  const bytes = Buffer.byteLength(snapshot, 'utf8');
  if (USE_PG) {
    await pool.query('INSERT INTO backups (snapshot, size_bytes, created_at) VALUES ($1,$2,NOW())', [snapshot, bytes]);
  } else {
    sqlite.prepare('INSERT INTO backups (snapshot, size_bytes, created_at) VALUES (?,?,datetime(\'now\'))').run(snapshot, bytes);
  }
}
async function backupList(limit) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const n = Math.max(1, Math.min(30, Number(limit) || 10));
    const t = await _cloudTableGet('backups');
    return t.rows.slice().sort((a, b) => b.id - a.id).slice(0, n).map(r => ({ id: r.id, size_bytes: r.size_bytes, created_at: r.created_at }));
  }
  const n = Math.max(1, Math.min(30, Number(limit) || 10));
  if (USE_PG) {
    const r = await pool.query('SELECT id, size_bytes, created_at FROM backups ORDER BY id DESC LIMIT $1', [n]);
    return r.rows;
  }
  return sqlite.prepare('SELECT id, size_bytes, created_at FROM backups ORDER BY id DESC LIMIT ?').all(n);
}
async function backupGet(id) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('backups');
    const r = t.rows.find(x => Number(x.id) === Number(id));
    return r ? r.snapshot : null;
  }
  if (USE_PG) {
    const r = await pool.query('SELECT snapshot FROM backups WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].snapshot : null;
  }
  const row = sqlite.prepare('SELECT snapshot FROM backups WHERE id = ?').get(id);
  return row ? row.snapshot : null;
}
async function backupTrim(keep) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const n = Math.max(1, Math.min(30, Number(keep) || 7));
    const t = await _cloudTableGet('backups');
    t.rows.sort((a, b) => b.id - a.id);
    if (t.rows.length > n) { t.rows = t.rows.slice(0, n); return _cloudTableSave('backups'); }
    return;
  }
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
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('pay_orders');
    return t.rows.some(r => r.out_trade_no === outTradeNo);
  }
  if (USE_PG) {
    const r = await pool.query('SELECT 1 FROM pay_orders WHERE out_trade_no = $1', [outTradeNo]);
    return r.rows.length > 0;
  }
  return !!sqlite.prepare('SELECT 1 FROM pay_orders WHERE out_trade_no = ?').get(outTradeNo);
}async function orderMark(outTradeNo, channel, userId, amount) {
  try {
    /* 🔴 云存储模式 */
    if (USE_CLOUD_STORAGE) {
      const t = await _cloudTableGet('pay_orders');
      if (!t.rows.some(r => r.out_trade_no === outTradeNo)) {
        t.rows.push({ out_trade_no: outTradeNo, channel: channel || 'afdian', user_id: userId || 0, amount: String(amount || '') });
        return _cloudTableSave('pay_orders');
      }
      return;
    }
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
  if (USE_CLOUD_STORAGE) return cloudUserByEmail(email);
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

async function userFindByOpenid(openid) {
  if (USE_CLOUD_STORAGE) return cloudUserByOpenid(openid);
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE wx_openid = $1', [openid]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE wx_openid = ?').get(openid);
}

async function userBindEmail(uid, email) {
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { email: (email||'').toLowerCase() || null });
  if (USE_PG) {
    await pool.query('UPDATE users SET email = $1, email_verified = 0 WHERE id = $2', [email, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET email = ?, email_verified = 0 WHERE id = ?').run(email, uid);
}

async function userVerifyEmail(uid) {
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { email_verified: 1 });
  if (USE_PG) {
    await pool.query('UPDATE users SET email_verified = 1 WHERE id = $1', [uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(uid);
}

async function userSetWechat(uid, wechat) {
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { wechat: wechat || null });
  if (USE_PG) {
    await pool.query('UPDATE users SET wechat = $1 WHERE id = $2', [wechat, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET wechat = ? WHERE id = ?').run(wechat, uid);
}

async function userBindOpenid(uid, openid) {
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { wx_openid: openid || null });
  if (USE_PG) {
    await pool.query('UPDATE users SET wx_openid = $1 WHERE id = $2', [openid, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET wx_openid = ? WHERE id = ?').run(openid, uid);
}

async function userSetPassword(uid, pw_hash) {
  /* 🔴 pw_set=1：标记已设过密码（set-first 只在未设时允许，防已登录会话覆盖密码） */
  if (USE_CLOUD_STORAGE) return cloudUserSet(uid, { pw_hash, pw_set: 1 });
  if (USE_PG) {
    await pool.query('UPDATE users SET pw_hash = $1, pw_set = 1 WHERE id = $2', [pw_hash, uid]);
    return;
  }
  sqlite.prepare('UPDATE users SET pw_hash = ?, pw_set = 1 WHERE id = ?').run(pw_hash, uid);
}

/* ---------- 分享快照（v0.6：规划生成链接一键套用） ---------- */
async function shareCreate(id, owner, title, dataStr) {
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('shares');
    const ex = t.rows.find(r => String(r.id) === String(id));
    if (ex) { ex.owner = owner; ex.title = title; ex.data = dataStr; ex.created_at = new Date().toISOString(); }
    else t.rows.push({ id, owner, title, data: dataStr, created_at: new Date().toISOString() });
    return _cloudTableSave('shares');
  }
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
  /* 🔴 云存储模式 */
  if (USE_CLOUD_STORAGE) {
    const t = await _cloudTableGet('shares');
    const r = t.rows.find(x => String(x.id) === String(id));
    return r ? { id: r.id, owner: r.owner, title: r.title, data: r.data } : null;
  }
  if (USE_PG) {
    const r = await pool.query(`SELECT id,owner,title,data FROM shares WHERE id=$1`, [id]);
    return r.rows[0];
  }
  return sqlite.prepare(`SELECT id,owner,title,data FROM shares WHERE id=?`).get(id);
}

/* 🔴 合并后清理 wx_ 孤儿账号：openid 已转走，清空身份字段（wechat/display_name/email/wx_openid）
 * + 随机化密码（无法再登录）+ 删除 profile（不留旧数据副本）。
 * 保留 user 行（防 openid 冲突/分享关联断裂），但账号彻底不可用、不可见。 */
async function orphanWxAccount(uid) {
  if (USE_CLOUD_STORAGE) {
    try {
      const fileID = cloudFileID(uid);
      if (fileID) await cloudApp().deleteFile({ fileList: [fileID] });
    } catch (e) { console.warn('⚠️ 孤儿清理删云存储 profile 失败：', (e && e.message) || e); }
    /* 🔴 orphan 清理写 users.json——失败时重试一次 wx_openid 清空（最关键的字段：
     * openid 不清 → 两账号同 openid → userFindByOpenid 顺序敏感 → 用户可能登入废弃号） */
    try { return await cloudUserSet(uid, { wechat: null, display_name: null, email: null, wx_openid: null, pw_hash: cryptoRandomHash(), pw_set: 0, orphaned: 1 }); }
    catch (e) {
      console.warn('⚠️ 孤儿清理 users.json 失败，重试清 openid:', (e && e.message) || e);
      try { await cloudUserSet(uid, { wx_openid: null }); } catch (e2) { console.warn('⚠️ 重试也失败:', (e2 && e2.message) || e2); }
      return true; /* 阻塞合并结果没有意义——目标账号 openid 已转移成功 */
    }
  }
  if (USE_PG) {
    await pool.query(`UPDATE users SET wechat = NULL, display_name = NULL, email = NULL, wx_openid = NULL, pw_hash = $1, pw_set = 0, orphaned = 1 WHERE id = $2`, [cryptoRandomHash(), uid]);
    await pool.query('DELETE FROM profiles WHERE user_id = $1', [uid]);
    return;
  }
  sqlite.prepare(`UPDATE users SET wechat = NULL, display_name = NULL, email = NULL, wx_openid = NULL, pw_hash = ?, pw_set = 0, orphaned = 1 WHERE id = ?`).run(cryptoRandomHash(), uid);
  sqlite.prepare('DELETE FROM profiles WHERE user_id = ?').run(uid);
}

/* 随机密码哈希（孤儿账号不可再登录） */
function cryptoRandomHash() {
  const rnd = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  return '$2b$10$' + rnd + rnd; /* 长度伪造，bcrypt.compareSync 必失败 */
}

/* 注销账号（PIPL 第 47 条 + 微信审核硬项）：删除该用户全部关联数据与账号行
 * templates 按 author 字符串关联（无 owner 列），故需传入 username */
async function userDelete(uid, username) {
  /* 云存储模式：删 profile 文件 + 从 users.json 移除该用户 */
  if (USE_CLOUD_STORAGE) {
    try {
      const fileID = cloudFileID(uid);
      if (fileID) await cloudApp().deleteFile({ fileList: [fileID] });
    } catch (e) { console.warn('⚠️ 注销删 profile 失败:', (e && e.message) || e); }
    const u = await cloudUsersLoad();
    u.users = u.users.filter(x => Number(x.id) !== Number(uid));
    await cloudUsersSave();
    /* 🔴 云模式注销清理辅助表孤儿行（与 PG/SQLite 分支一致）：
     * notifications/ratings/favorites/pay_orders 按 user_id、shares 按 owner 过滤 */
    for (const name of ['notifications', 'ratings', 'favorites', 'pay_orders']) {
      try {
        const t = await _cloudTableGet(name);
        const before = t.rows.length;
        t.rows = t.rows.filter(x => Number(x.user_id) !== Number(uid));
        if (t.rows.length !== before) await _cloudTableSave(name);
      } catch (e) { console.warn('⚠️ 注销清理 ' + name + ' 失败:', (e && e.message) || e); }
    }
    try {
      const t = await _cloudTableGet('shares');
      const before = t.rows.length;
      t.rows = t.rows.filter(x => Number(x.owner) !== Number(uid));
      if (t.rows.length !== before) await _cloudTableSave('shares');
    } catch (e) { console.warn('⚠️ 注销清理 shares 失败:', (e && e.message) || e); }
    /* subs/sent 单独云文件（subs.json）也要清 */
    try {
      const s = await cloudSubsLoad();
      if (s[String(uid)] !== undefined) { delete s[String(uid)]; await _cloudJsonSave(CLOUD_SUBS_FILE, s, _cloudSubsWriteQ); }
    } catch (e) { console.warn('⚠️ 注销清理 subs 失败:', (e && e.message) || e); }
    return;
  }
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
  /* 🔴 云存储模式（方案 B）：删所有 profile 文件 + 重置 users.json */
  if (USE_CLOUD_STORAGE) {
    const all = await cloudUserAll();
    const n = all.length;
    try {
      const fileList = all.map(u => cloudFilePath(u.id));
      if (fileList.length) await cloudApp().deleteFile({ fileList });
    } catch (e) { console.warn('⚠️ wipe: 云存储 profile 删除失败:', (e && e.message) || e); }
    await cloudWipeUsers();
    /* 清订阅/去重标记（敏感信息） */
    _cloudSubs = {}; await _cloudJsonSave(CLOUD_SUBS_FILE, {}, _cloudSubsWriteQ);
    _cloudSent = {}; await _cloudJsonSave(CLOUD_SENT_FILE, {}, _cloudSentWriteQ);
    /* 🔴 清社区模板（云存储 templates.json + 内存缓存）——wipe 应回到全新状态 */
    _cloudTemplates = { seq: 0, list: [] };
    try { await _cloudJsonSave(CLOUD_TEMPLATES_FILE, _cloudTemplates, _cloudTemplatesWriteQ); }
    catch (e) { console.warn('⚠️ wipe: templates.json 清理失败:', (e && e.message) || e); }
    /* 🔴 清辅助表（notifications/ratings/favorites/shares/backups/pay_orders） */
    for (const name of Object.keys(CLOUD_TABLE_FILES)) {
      _cloudTables[name] = { seq: 0, rows: [] };
      try { await _cloudTableSave(name); } catch (e) { console.warn('⚠️ wipe: ' + name + ' 清理失败:', (e && e.message) || e); }
    }
    console.log('  🗑️ 云存储 users.json 已重置, profile 清理:', n);
    return n;
  }
  /* 子表先删，主表最后（无外键，但保持合理顺序）；逐个 try/catch——某表失败不阻塞其他 */
  const tables = ['notifications', 'ratings', 'favorites', 'shares', 'subscriptions', 'pay_orders', 'backups', 'templates', 'profiles', 'users'];
  let deleted = 0;
  const allUids = [];
  if (USE_PG) {
    try {
      const r = await pool.query('SELECT id FROM users');
      deleted = r.rows.length; r.rows.forEach(x => allUids.push(Number(x.id)));
    } catch (e) { console.warn('wipeAllUsers: 统计用户数失败', e.message); }
    for (const t of tables) {
      try { await pool.query(`DELETE FROM ${t}`); console.log('  ✓ 已清空', t); }
      catch (e) { console.warn('  ⚠️ 清空失败（跳过）:', t, e.message); }
    }
  } else {
    try { const rows = sqlite.prepare('SELECT id FROM users').all(); deleted = rows.length; rows.forEach(x => allUids.push(Number(x.id))); } catch (e) {}
    const del = sqlite.transaction(() => { tables.forEach(t => { try { sqlite.prepare(`DELETE FROM ${t}`).run(); } catch (e) { console.warn('⚠️ 清空失败（跳过）:', t, e.message); } }); });
    del();
  }
  /* 🔴 云存储模式：按删除前的 uid 列表逐文件删 profiles/（无法列目录，但 uid 列表可得）——隐私兜底 */
  if (USE_CLOUD_STORAGE && allUids.length) {
    try {
      const fileList = allUids.map(u => cloudFilePath(u));
      const res = await cloudApp().deleteFile({ fileList });
      console.log('  🗑️ 云存储 profile 文件清理:', (res && res.fileList || []).length, '/', allUids.length);
    } catch (e) { console.warn('⚠️ 云存储 profile 清理失败（孤儿文件无害）:', (e && e.message) || e); }
  }
  return deleted;
}

module.exports = { init, isConnected, userByName, userByNameCI, userById, userByDisplayName, userByWechat, wechatTaken, userSetDisplayName, setDisplayNameWithRetry, createUser, userFindByEmail, userFindByOpenid, userBindEmail, userVerifyEmail, userSetWechat, userBindOpenid, userSetPassword, userUnlock, userSetDev, userDelete, orphanWxAccount, wipeAllUsers, orderSeen, orderMark, backupSave, backupList, backupGet, backupTrim, profileGet, profileUpdatedAt, profileSet, adminUsers, dbStats, templateAdd, templateListApproved, templateListAll, templateGet, templateApprove, templateReject, templateUpdate, templateDelete, notify, notificationList, notificationUnreadCount, notificationMarkRead, ratingUpsert, ratingStats, favoriteToggle, favoriteIs, shareCreate, shareGet, subUpsert, subEnabledList, sentOnce, USE_PG, USE_CLOUD_STORAGE, CLOUD_ENV, get _cloudBucket() { return _cloudBucket; } };

/* ---------- 订阅消息（微信提醒） ---------- */
/* ================= 订阅消息云存储层（方案B 优化2：辅助表持久化） =================
 * subscriptions 存 subs.json（云存储，重启不丢）；sent_logs 存 sent.json */
const CLOUD_SUBS_FILE = 'subs.json';
const CLOUD_SENT_FILE = 'sent.json';
const CLOUD_TEMPLATES_FILE = 'templates.json';
let _cloudSubs = null, _cloudSubsLoading = null;
let _cloudSent = null, _cloudSentLoading = null;
let _cloudTemplates = null, _cloudTemplatesLoading = null;

/* 🔴 通用 JSON 文件加载：loading 用 Map（支持任意文件，辅助表持久化用） */
const _cloudJsonLoading = new Map();
async function _cloudJsonLoad(file, cacheGetter, cacheSetter) {
  if (cacheGetter()) return cacheGetter();
  if (_cloudJsonLoading.has(file)) return _cloudJsonLoading.get(file);
  const p = (async () => {
    try {
      let fileID = cloudFileID0(file);
      if (!fileID) { if (!(await ensureCloudBucket())) throw new Error('bucket'); fileID = cloudFileID0(file); if (!fileID) throw new Error('fileID'); }
      const raw = await cloudDownloadLatest(fileID);
      if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') { cacheSetter(j); return j; }
      }
      const empty = {}; cacheSetter(empty); return empty;
    } catch (e) {
      /* 🔴 读失败抛（不返回空缓存）——防被空缓存覆盖丢失 */
      console.error('⚠️ ' + file + ' 读取失败（抛错防覆盖）:', (e && e.message) || e);
      throw e;
    }
  })();
  _cloudJsonLoading.set(file, p);
  p.finally(() => _cloudJsonLoading.delete(file));
  return p;
}
async function _cloudJsonSave(file, data, q) {
  q.value = q.value.then(async () => {
    const res = await cloudApp().uploadFile({ cloudPath: file, fileContent: Buffer.from(JSON.stringify(data), 'utf8') });
    if (!res) throw new Error('上传无响应');
    if (res.code && res.code !== 'SUCCESS' && res.code !== 0) throw new Error('上传失败: ' + (res.message || res.code));
  }).catch(e => console.warn('⚠️ ' + file + ' 写入失败:', (e && e.message) || e));
  return q.value;
}
const _cloudSubsWriteQ = { value: Promise.resolve() };
const _cloudSentWriteQ = { value: Promise.resolve() };

/* 🔴 辅助表云存储持久化（通用）：notifications/ratings/favorites/shares/backups/pay_orders 存 <name>.json {seq,rows} */
const CLOUD_TABLE_FILES = {
  notifications: 'notifications.json', ratings: 'ratings.json', favorites: 'favorites.json',
  shares: 'shares.json', backups: 'backups.json', pay_orders: 'pay_orders.json'
};
let _cloudTables = {};
const _cloudTableWriteQs = {};
async function _cloudTableGet(name) {
  const file = CLOUD_TABLE_FILES[name];
  if (!file) throw new Error('未知云表: ' + name);
  if (!_cloudTables[name]) {
    const d = await _cloudJsonLoad(file, () => _cloudTables[name], v => { _cloudTables[name] = v; });
    _cloudTables[name] = (d && Array.isArray(d.rows)) ? d : { seq: 0, rows: [] };
  }
  return _cloudTables[name];
}
async function _cloudTableSave(name) {
  const file = CLOUD_TABLE_FILES[name];
  if (!_cloudTableWriteQs[name]) _cloudTableWriteQs[name] = { value: Promise.resolve() };
  return _cloudJsonSave(file, _cloudTables[name] || { seq: 0, rows: [] }, _cloudTableWriteQs[name]);
}
const _cloudTemplatesWriteQ = { value: Promise.resolve() };

/* 🔴 templates 云存储持久化（{seq, list} 结构，兼容 DB 行字段） */
async function cloudTemplatesLoad() {
  return _cloudJsonLoad(CLOUD_TEMPLATES_FILE, () => _cloudTemplates, v => { _cloudTemplates = v; });
}
async function cloudTemplatesSave() {
  const d = _cloudTemplates || { seq: 0, list: [] };
  return _cloudJsonSave(CLOUD_TEMPLATES_FILE, d, _cloudTemplatesWriteQ);
}

async function cloudSubsLoad() { return _cloudJsonLoad(CLOUD_SUBS_FILE, () => _cloudSubs, v => { _cloudSubs = v; }); }
async function cloudSentLoad() { return _cloudJsonLoad(CLOUD_SENT_FILE, () => _cloudSent, v => { _cloudSent = v; }); }

async function subUpsert(userId, tplId, enabled) {
  const e = enabled ? 1 : 0;
  /* 🔴 云存储模式：subs.json 持久（重启不丢订阅） */
  if (USE_CLOUD_STORAGE) {
    const subs = await cloudSubsLoad();
    subs[String(userId)] = { tpl_id: tplId, enabled: e };
    return _cloudJsonSave(CLOUD_SUBS_FILE, subs, _cloudSubsWriteQ);
  }
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
  /* 🔴 云存储模式：subs.json + users.json 组合（SQLite subscriptions 无法 JOIN 云存储 users） */
  if (USE_CLOUD_STORAGE) {
    const subs = await cloudSubsLoad();
    const users = await cloudUserAll();
    const out = [];
    Object.keys(subs).forEach(uidStr => {
      const s = subs[uidStr];
      if (!s || s.enabled !== 1) return;
      const u = users.find(x => Number(x.id) === Number(uidStr));
      if (u && u.wx_openid) out.push({ userId: Number(uidStr), tplId: s.tpl_id, openid: u.wx_openid });
    });
    return out;
  }
  const sql = `SELECT s.user_id, s.tpl_id, u.wx_openid FROM subscriptions s
               JOIN users u ON u.id = s.user_id
               WHERE s.enabled = 1 AND u.wx_openid IS NOT NULL`;
  if (USE_PG) { const r = await pool.query(sql); return r.rows.map(x => ({ userId: x.user_id, tplId: x.tpl_id, openid: x.wx_openid })); }
  return sqlite.prepare(sql).all().map(x => ({ userId: x.user_id, tplId: x.tpl_id, openid: x.wx_openid }));
}

/* 提醒去重（跨进程幂等）：key 如 'remind-2026-08-09'，当天已发过返回 false。
 * 解决「常驻 setInterval + 云函数 cron」并存时的双下发。 */
async function sentOnce(key) {
  /* 🔴 云存储模式：sent.json 持久（重启不丢去重标记） */
  if (USE_CLOUD_STORAGE) {
    const sent = await cloudSentLoad();
    if (sent[key]) return false;
    sent[key] = 1;
    await _cloudJsonSave(CLOUD_SENT_FILE, sent, _cloudSentWriteQ);
    return true;
  }
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
