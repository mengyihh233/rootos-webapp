/* =====================================================================
 * 底层创造者OS — 多用户版后端
 * Node + Express + SQLite/Postgres(better-sqlite3 或 pg) + express-session + bcryptjs
 * 每个注册用户拥有独立的 dashboard 数据包（云端存储，天然多端同步）
 *
 * 数据库引擎由环境变量 DATABASE_URL 决定（见 db.js）：
 *   - 不设 → 本地 SQLite（data.db），适合开发 / 自托管 VPS
 *   - 设了 Postgres 连接串（如 Neon）→ 使用 Postgres，适合免费云平台部署
 * ===================================================================== */
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'rootos-dev-secret-change-me';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
/* 安全：生产环境使用默认 SESSION_SECRET 会被伪造 session/JWT 提权 → 拒绝启动 */
if (process.env.NODE_ENV === 'production' && SESSION_SECRET === 'rootos-dev-secret-change-me') {
  console.error('🚨 严重安全警告：生产环境使用默认 SESSION_SECRET（可被伪造会话/Token 提权，任意账号接管）。');
  console.error('   请在云托管环境变量设置随机 SESSION_SECRET（生成：openssl rand -hex 32）后重新部署。');
  process.exit(1);
}
/* 微信小程序登录（code2session）：AppID 公开，AppSecret 私密，只从环境变量读、绝不进代码 */
const WX_APPID = process.env.WX_APPID || '';
const WX_SECRET = process.env.WX_SECRET || '';
/* 启动诊断：打印 WX 配置状态（隐去敏感位），部署后在日志确认环境变量是否生效 */
console.log(`🔎 微信登录配置：WX_APPID=${WX_APPID ? WX_APPID.slice(0, 6) + '…' + WX_APPID.slice(-4) + '（共' + WX_APPID.length + '位）' : '⚠️未配置'} | WX_SECRET=${WX_SECRET ? '✅已配置（' + WX_SECRET.length + '位）' : '⚠️未配置'}`);

/* 小程序无 cookie，用 Bearer token 维持登录态。
 * 【v1.4 改造】改为无状态 JWT（HMAC-SHA256 + SESSION_SECRET 签名）：
 *   - 不存服务器内存 → 云托管实例重启/闲置回收后 token 依然有效
 *   - 过期 30 天；SESSION_SECRET 不变即可长期有效
 * 注：SESSION_SECRET 一旦更换，所有已签发 token 作废（重新登录即可）。 */
function b64url(buf){ return Buffer.from(buf).toString('base64url'); }
function signJwt(payload){
  const data = b64url(JSON.stringify(payload));
  return data + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}
function verifyJwt(token){
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  if (sig !== expect) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!p || !p.uid || Date.now() > (p.exp || 0)) return null;
    return p;
  } catch (e) { return null; }
}
function issueWxToken(uid){
  return signJwt({ uid, exp: Date.now() + 30 * 24 * 3600 * 1000 });
}
function wxUidFromReq(req){
  const m = /^Bearer\s+(.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return null;
  const p = verifyJwt(m[1]);
  return p ? p.uid : null;
}
/* 邮箱验证码 SMTP（QQ/163/126 等开启 SMTP 服务后填入授权码）：
 * 未配置时绑定/找回密码接口返回 503 并提示，功能自动降级为「仅绑定字符串」。 */
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || ''
};
function smtpReady() { return !!(SMTP.host && SMTP.user && SMTP.pass); }

/* 邮箱验证码暂存（进程内存）：key=email，值={code, uid(绑定场景) , exp}
 * 单实例够用；与 session 同生命周期（重启后需重新发码），多实例部署可换 Redis。 */
const emailCodes = new Map();
const _codeCooldown = new Map(); /* 验证码重发冷却（email → 上次发送时间） */
function issueCode(email) {
  const code = String(crypto.randomInt(100000, 1000000));
  emailCodes.set(email, { code, exp: Date.now() + 10 * 60 * 1000, fail: 0 });
  /* 防内存泄漏：超 1000 条时清理过期项 */
  if (emailCodes.size > 1000) {
    const now = Date.now();
    for (const [k, v] of emailCodes) { if (now > v.exp) emailCodes.delete(k); }
  }
  return code;
}
function checkCode(email, code) {
  const v = emailCodes.get(email);
  if (!v) return false;
  if (Date.now() > v.exp) { emailCodes.delete(email); return false; }
  if (String(code || '').trim() !== v.code) {
    v.fail = (v.fail || 0) + 1;
    if (v.fail >= 5) emailCodes.delete(email); /* 连续失败 5 次作废验证码，防爆破 */
    return false;
  }
  emailCodes.delete(email); /* 一次性使用 */
  return true;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* 发验证码邮件；返回 {ok, err?}。SMTP 未配置时 err='SMTP_NOT_CONFIGURED' */
async function sendCodeMail(email, code, purpose) {
  if (!smtpReady()) return { err: 'SMTP_NOT_CONFIGURED' };
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: SMTP.host, port: SMTP.port, secure: SMTP.port === 465,
      auth: { user: SMTP.user, pass: SMTP.pass }
    });
    await t.sendMail({
      from: SMTP.from, to: email,
      subject: purpose === 'reset' ? '【ROOT-OS】重置密码验证码' : '【ROOT-OS】邮箱绑定验证码',
      text: `你的验证码是：${code}\n10 分钟内有效。如非本人操作，请忽略本邮件。`
    });
    return { ok: true };
  } catch (e) {
    console.error('❌ 邮件发送失败：', e.message);
    return { err: 'SEND_FAILED' };
  }
}

/* ---------- 新用户默认数据包 ----------
 * 通用启动模板（已剔除私人化内容：无「戒断」门类、无具体时间/地点黑话；
 * 保留 💥崩溃机制与 🔀支链降级概念，承接 RSIP/CTDP 设计哲学）。
 * 内容与前端 public/index.html 的 SEED_* 保持一致，
 * 这样无论数据来自服务器还是本地兜底，新用户看到的都是同一套模板。 */
function dayOff(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv');
}

/* 注册默认显示名：用户名清洗（@ 前部分 + 白名单字符 + 截16位），清洗后不足 2 位用「用户+id」 */
function defaultDisplayName(username, uid) {
  let base = String(username || '').split('@')[0];
  base = base.replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]/g, '').slice(0, 16);
  if (base.length < 2) base = '用户' + (uid || Math.floor(Math.random() * 10000));
  return base;
}

function defaultBag() {
  /* 轻量引导版：新用户 3 天学会系统，不劝退。
   * 原完整版（5 门类 27 规则）已迁移为官方模板 classic.json，需要可在模板市场套用。
   * 内容与前端 public/index.html 的 SEED_* 保持一致。 */
  return {
    cats: [
      { id: 'c_start',  name: '起步', color: '#4fc1ff' },
      { id: 'c_health', name: '健康', color: '#4ec9b0' }
    ],
    levels: [
      { id: 'lv0', name: '根部' },
      { id: 'lv1', name: '中层' },
      { id: 'lv2', name: '顶层' }
    ],
    /* parent=null 为主链节点；parent=某规则 id 为该节点的支链（主链崩溃时才激活） */
    rules: [
      /* 起步 */
      { id: 'r_st1', cat: 'c_start', lv: 'lv0', t: '完成 1 次打卡（先试试点一下）', on: true, parent: null, seq: 1 },
      { id: 'r_st2', cat: 'c_start', lv: 'lv0', t: '两分钟规则：不想做就先做 2 分钟', on: true, parent: null, seq: 2, micro: '只做 2 分钟，时间到再决定续不续' },
      { id: 'r_st3', cat: 'c_start', lv: 'lv1', t: '崩溃了？点 💥 记一笔（不归零）', on: true, parent: null, seq: 1 },
      { id: 'r_st4', cat: 'c_start', lv: 'lv2', t: '睡前写下今天的一句话复盘', on: true, parent: null, seq: 1 },
      /* 健康 */
      { id: 'r_ht1', cat: 'c_health', lv: 'lv0', t: '今晚 12 点前睡觉', on: true, parent: null, seq: 1 },
      { id: 'r_ht2', cat: 'c_health', lv: 'lv1', t: '每天户外光照 10 分钟', on: true, parent: null, seq: 1 }
    ],
    tags: [
      { id: 't_social', name: '社交日',   color: '#e8912d', degrade: true },
      { id: 't_sleepy', name: '低能量日', color: '#569cd6', degrade: true }
    ],
    daily: {},
    events: [],
    phases: [
      { id: 'p1', parent: null, name: '第 1 周 · 认识系统', start: dayOff(0), end: dayOff(6), imp: 3, done: false, journal: '',
        goal: '每天完成根部打卡；周日晚打开「回溯 → 周视图」写第一次周复盘，就明白这套系统怎么运转' }
    ],
    reviews: { day: {}, week: {}, month: {} },
    retros: [
      { id: 'rt0', date: '', text: '📖 3 天快速上手：\n1. 点一下规则 = 完成打卡；点 💥 = 今日崩溃（可走支链）。\n2. 规则不够用？「规则」页点右上角编辑，自己加。\n3. 崩溃不归零：去「回溯 → 定式迭代台」记一笔、改规则，明天重启。\n4. 周日晚写周复盘，系统就转起来了。\n更多模板在「模板市场」，随时可换。' }
    ],
    resources: [
      { id: 'res0', title: '新手手册：这套系统怎么用', body: '规则树：根部=保命定式，中层=推进动作，顶层=冲刺目标。\n标记：社交日/低能量日打上后自动降级（只保根部，不追责）。\n迭代：崩了 → 回溯迭代台 → 改规则 → 次日重启。\n数据都在云端，网页和小程序实时同步。', tags: ['新手'], updatedAt: '' }
    ],
    meta: { version: 'webapp-1.0', _seed: true } /* _seed 标记=默认数据，账号绑定/合并时用于识别临时账号 */
  };
}

/* ---------- 失败模式分析（用户 / 管理员共用） ----------
 * 输入单个用户的数据包（对象或 JSON 串），输出：
 *   totalCrashes  总崩溃次数
 *   totalRecovered 崩溃后走了支链（恢复）的次数
 *   branchRate    支链恢复率
 *   topCrashed    崩溃最多的定式排行（含各自恢复率）
 * 判定「走了支链」：该崩溃事件发生在某天，且当天 daily[day].checks 里勾选了
 * 它的任意子节点（parent === 崩溃定式 id）。 */
function computeFailureAnalysis(d0) {
  let data = {};
  try { data = typeof d0 === 'string' ? JSON.parse(d0 || '{}') : (d0 || {}); } catch (e) { data = {}; }
  const crashByRule = {};
  let totalCrashes = 0, totalRecovered = 0;
  const ruleMap = {}; (data.rules || []).forEach(x => { ruleMap[x.id] = x.t || x.id; });
  const daily = data.daily || {};
  const crashEvents = (data.events || []).filter(e => e.type === 'crash' && e.ruleId);
  for (const e of crashEvents) {
    const rid = e.ruleId;
    const txt = ruleMap[rid] || rid;
    if (!crashByRule[txt]) crashByRule[txt] = { count: 0, recovered: 0 };
    crashByRule[txt].count++; totalCrashes++;
    const day = e.day || (e.ts ? String(e.ts).slice(0, 10) : null);
    const childIds = (data.rules || []).filter(x => x.parent === rid).map(x => x.id);
    const rec = day ? daily[day] : null;
    const tookBranch = rec && rec.checks && childIds.some(cid => rec.checks[cid]);
    if (tookBranch) { crashByRule[txt].recovered++; totalRecovered++; }
  }
  const topCrashed = Object.keys(crashByRule)
    .map(t => ({ rule: t, count: crashByRule[t].count, recovered: crashByRule[t].recovered,
      rate: crashByRule[t].count ? Math.round(crashByRule[t].recovered / crashByRule[t].count * 100) : 0 }))
    .sort((a, b) => b.count - a.count).slice(0, 12);
  return {
    totalCrashes,
    totalRecovered,
    branchRate: totalCrashes ? Math.round(totalRecovered / totalCrashes * 100) : 0,
    topCrashed
  };
}

/* ---------- Express ---------- */
/* 自动备份：每日把全库快照写入 backups 表（数据库内持久，零依赖零凭证）。
 * 保留最近 BACKUP_KEEP 份（默认 7）；配合 Neon PITR 双重保险。
 * admin 可随时「立即备份」/下载（见 /api/admin/backup*）。 */
const BACKUP_KEEP = Math.max(1, Math.min(30, Number(process.env.BACKUP_KEEP) || 7));
/* 云开发环境 ID 探测：与 db.js CLOUD_ENV 保持一致（TCB_ENV > TCB_ENV_ID > SCF_NAMESPACE） */
const CLOUD_ENV = process.env.TCB_ENV || process.env.TCB_ENV_ID || process.env.SCF_NAMESPACE || '';
/* 云存储双保险备份：数据库内快照之外，再上传一份到 CloudBase 云存储。
 * 正确用法（已查证 @cloudbase/node-sdk 文档）：app.init({env:TCB_ENV}).uploadFile({cloudPath, fileContent})
 * —— 云托管环境自动注入 TCB_ENV + 临时密钥，免手动配密钥；桶是环境自动分配（cloudbasestorage-<envId>）。
 * 非云托管环境（无 TCB_ENV，如本地开发）静默跳过，不影响数据库内备份。 */
async function uploadSnapshotToCOS(snapshotStr, dateStr) {
  if (!db.USE_CLOUD_STORAGE) return '跳过（未启用云存储引擎，仅存数据库内）';
  try {
    const cloudbase = require('@cloudbase/node-sdk');
    const app = cloudbase.init({
      env: CLOUD_ENV,
      secretId: process.env.TENCENTCLOUD_SECRETID || undefined,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY || undefined,
      sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      accessKey: process.env.CLOUDBASE_APIKEY || undefined
    });
    await app.uploadFile({
      cloudPath: 'rootos-backups/rootos-' + dateStr + '.json',
      fileContent: Buffer.from(snapshotStr, 'utf8')
    });
    /* 清理过期备份文件：保留最近 BACKUP_KEEP 天，删更早的（fileID 需 bucket 已缓存；失败静默） */
    if (db._cloudBucket && CLOUD_ENV) {
      try {
        const ids = [];
        for (let i = BACKUP_KEEP; i < 60; i++) {
          const d = new Date(Date.now() - i * 86400000);
          const key = 'rootos-backups/rootos-' + d.toISOString().slice(0, 10) + '.json';
          ids.push('cloud://' + CLOUD_ENV + '.' + db._cloudBucket + '/' + key);
        }
        if (ids.length) await app.deleteFile({ fileList: ids });
      } catch (e) { console.warn('⚠️ 云存储旧备份清理跳过：', (e && e.message) || e); }
    }
    return '已上传云存储';
  } catch (e) {
    console.warn('⚠️ 云存储备份上传失败（不影响数据库内备份）：', (e && e.message) || e);
    return '上传失败';
  }
}
async function runAutoBackup() {
  if (!db.isConnected()) return;
  try {
    const rows = await db.adminUsers();
    const snapshot = {
      at: new Date().toISOString(),
      app: 'rootos-webapp',
      users: rows.map(r => ({
        id: r.id, username: r.username,
        email: r.email || null, wechat: r.wechat || null, wx_openid: r.wx_openid || null,
        is_dev: r.is_dev || 0,
        created_at: r.created_at, updated_at: r.updated_at,
        data: (() => { try { return JSON.parse(r.data || '{}'); } catch (e) { return {}; } })()
      }))
    };
    const snapshotStr = JSON.stringify(snapshot);
    await db.backupSave(snapshotStr);
    await db.backupTrim(BACKUP_KEEP);
    const dateStr = new Date().toISOString().slice(0, 10);
    const cosNote = await uploadSnapshotToCOS(snapshotStr, dateStr);
    console.log('✅ 自动备份完成：', new Date().toISOString(), '(' + cosNote + ')');
  } catch (e) {
    console.warn('⚠️ 自动备份失败：', (e && e.message) || e);
  }
}
function scheduleAutoBackup() {
  /* 启动后先跑一次（数据库就绪时），再每天 0 点执行 */
  setTimeout(() => runAutoBackup(), 30 * 1000);
  const now = new Date();
  const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0).getTime() - now.getTime();
  setTimeout(() => { runAutoBackup(); setInterval(runAutoBackup, 24 * 3600 * 1000); }, Math.max(msToMidnight, 60000));
}

/* ============ 微信订阅消息（每日打卡提醒 / 周日复盘提醒） ============
 * 启用条件：环境变量 WX_APPID/WX_SECRET（已有）+ WX_SUB_TMPL_REMIND（打卡提醒模板 ID）
 * 可选 WX_SUB_TMPL_WEEKLY（复盘提醒模板 ID）。模板字段需含 thing1（内容）/time2（时间）。 */
let wxTokenCache = { token: '', expire: 0 };
async function getWxAccessToken() {
  if (wxTokenCache.token && Date.now() < wxTokenCache.expire) return wxTokenCache.token;
  const appid = process.env.WX_APPID, secret = process.env.WX_SECRET;
  if (!appid || !secret) return null;
  try {
    const r = await fetch(`https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`).then(r => r.json());
    if (r.access_token) { wxTokenCache = { token: r.access_token, expire: Date.now() + (Number(r.expires_in) - 300) * 1000 }; return r.access_token; }
    console.warn('⚠️ 获取微信 access_token 失败：', (r && r.errmsg) || JSON.stringify(r));
  } catch (e) { console.warn('⚠️ access_token 请求异常：', e.message); }
  return null;
}
async function sendSubMsg(openid, tplId, page, data) {
  const token = await getWxAccessToken();
  if (!token) return false;
  try {
    const r = await fetch('https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=' + token, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: openid, template_id: tplId, page: page || 'pages/today/today', data })
    }).then(r => r.json());
    if (r.errcode && r.errcode !== 0) console.warn('⚠️ 订阅消息发送失败：', r.errcode, r.errmsg);
    return r.errcode === 0;
  } catch (e) { console.warn('⚠️ 订阅消息发送异常：', e.message); return false; }
}
/* 定时下发：每天 20:00 打卡提醒；周日 20:00 复盘提醒
 * 模板 ID：内置默认（可被环境变量 WX_SUB_TMPL_REMIND 覆盖；字段需含 thing1 内容 / time2 时间） */
async function sendReminders() {
  const tplRemind = process.env.WX_SUB_TMPL_REMIND || '8fNCm2pRTLOEZPoio3uUm88iEER2VpchKRyTEjpVrzk';
  const tplWeekly = process.env.WX_SUB_TMPL_WEEKLY;
  if (!tplRemind && !tplWeekly) {
    console.warn('⏰ 订阅消息未启用：请配置环境变量 WX_SUB_TMPL_REMIND（打卡提醒模板 ID），可选 WX_SUB_TMPL_WEEKLY（周复盘模板 ID）');
    return;
  }
  /* 🔴 去重：当天（北京）已发过则跳过——常驻 setInterval 与云函数 cron 并存时防双下发 */
  const beijing = new Date(Date.now() + 8 * 3600 * 1000);
  const dayKey = beijing.toISOString().slice(0, 10);
  if (!(await db.sentOnce('remind-' + dayKey))) {
    console.log('⏰ 今日提醒已发过（remind-' + dayKey + '），跳过');
    return;
  }
  const subs = await db.subEnabledList();
  if (!subs.length) return;
  const isSunday = new Date().getDay() === 0;
  for (const s of subs) {
    try {
      if (isSunday && tplWeekly) {
        await sendSubMsg(s.openid, tplWeekly, 'pages/review/review', { thing1: { value: '周末复盘：花 30 分钟回顾本周，迭代你的定式' }, time2: { value: '20:00' } });
      } else if (tplRemind) {
        await sendSubMsg(s.openid, tplRemind, 'pages/today/today', { thing1: { value: '今天也要跑通你的定式链，打开 ROOT-OS 打卡' }, time2: { value: '20:00' } });
      }
    } catch (e) { console.warn('⚠️ 提醒下发失败（用户 ' + s.userId + '）：', e.message); }
  }
}
function scheduleReminders() {
  let lastSendKey = '';
  setInterval(async () => {
    const now = new Date();
    /* 🔴 修复：云托管容器默认 UTC 时区，getHours() 是 UTC 小时 → 会凌晨 4 点发。
     * 统一按东八区（北京）换算：北京 20:00-20:30 触发。 */
    const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
    const bjHours = beijing.getUTCHours(); /* 东八区的小时 = UTC+8 的 UTC 小时 */
    if (bjHours === 20 && beijing.getUTCMinutes() < 30) {
      const key = beijing.toISOString().slice(0, 10) + (beijing.getUTCDay() === 0 ? '-wk' : '-day');
      if (key !== lastSendKey) { lastSendKey = key; try { await sendReminders(); } catch (e) { console.warn('⚠️ 提醒下发失败：', e.message); } }
    }
  }, 10 * 60 * 1000);
}

async function start() {
  /* 注意：数据库初始化不再阻塞启动、也不再因连接失败而退出进程。
   * 先起 HTTP 服务（让 Render 健康检查 / 通过），数据库由后台循环异步连接，
   * Neon 免费层冷启动时连不上只会持续重试并打日志，不会触发 status 1 部署失败。 */
  const app = express();
  /* 部署在 Nginx / Caddy / Render 反代之后时必须开启，
   * 否则 NODE_ENV=production 下 cookie 的 secure 标志会导致登录态无法建立 */
  app.set('trust proxy', 1);

  /* 安全响应头：纵深防御 XSS / MIME 嗅探 / Referrer 泄露。
   * 重要教训：CSP 中 'unsafe-inline' 与 'nonce-' 同现时，现代浏览器会【忽略 unsafe-inline】，
   * 而 nonce 只对 <script>/<style> 元素有效、覆盖不了 style="..." 属性与 onclick="..." 事件属性
   * —— 本站在线内联样式/事件较多，曾被此规则全量拦截（登录遮罩失去 position:fixed 等），
   * 故在事件绑定重构为 addEventListener 之前，CSP 只保留 'unsafe-inline'、不使用 nonce。
   * 收紧 object-src='none'（禁用插件/嵌套浏览上下文）、base-uri/form-action 已限 'self'。
   * 注意：frame-ancestors 故意不限制，以免破坏 WorkBuddy 预览的跨域 iframe（沿用既有决策）。 */
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
      "base-uri 'self'; form-action 'self'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  /* Gzip 压缩（性能）：整包 JSON（/api/data 等）文本压缩率高，显著降流量与传输时间 */
  app.use(require('compression')());

  app.use(express.json({ limit: '60mb' }));
  /* 会话持久化：默认内存 store（单实例够用）。
   * ⚠️ 方案3 后：不再用 connect-pg-simple 存 session——它会把每次请求的 session 读写打进 PG，
   * 破坏"PG 只剩 users 小表"的省钱目标。内存 store 代价：云托管实例重启后需重新登录（冷启动本就少见，可接受）。
   * 未来多实例/要高可用时再换 Redis（env SESSION_STORE=redis 预留）。 */
  const sessConf = {
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 3600 * 1000 }
  };
  app.use(session(sessConf));

  /* DB 未就绪时，/api 请求返回 503（而非 500 崩溃），避免未连接状态下的异常扩散。
   * 必须在所有 /api 路由之前注册。静态首页 / 管理页不依赖 DB，始终可访问。 */
  app.use((req, res, next) => {
    if (!db.isConnected() && req.path.startsWith('/api/')) {
      return res.status(503).json({ error: '数据库正在连接中，请稍候重试' });
    }
    next();
  });

  /* 把 async 路由的错误统一兜成 500，避免 Express 4 吞掉未捕获的 Promise reject */
  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('❌ 路由错误：', err);
      /* 开发期诊断：非生产返回 detail（定位云存储/逻辑错误）；生产仍隐藏细节（merge-web 500 已定位并修复） */
      if (!res.headersSent) {
        if (process.env.NODE_ENV !== 'production') res.status(500).json({ error: '服务器内部错误', detail: (err && err.message) || String(err) });
        else res.status(500).json({ error: '服务器内部错误' });
      }
    });

  /* 登录 / 注册爆破防护：同一 IP 在 15 分钟内失败超过 20 次即限流（返回 429）。
   * 成功一次即清空该 IP 的失败计数。内存级、单机够用；多实例部署可换 Redis。 */
  const authFails = new Map();
  function authFail(ip) {
    const now = Date.now(), win = 15 * 60 * 1000;
    let b = authFails.get(ip);
    if (!b || now > b.reset) { b = { n: 0, reset: now + win }; authFails.set(ip, b); }
    b.n++;
    /* 防内存泄漏：条目过多时清理已过期记录（含被伪造 IP 刷量的场景） */
    if (authFails.size > 5000) {
      for (const [k, v] of authFails) { if (now > v.reset) authFails.delete(k); }
    }
    return b.n > 20;
  }
  function authOk(ip) { authFails.delete(ip); }

  /* 统一鉴权：网页走 session cookie，小程序走 Bearer token；后续逻辑统一用 req.session.userId */
  function requireAuth(req, res, next) {
    if (req.session.userId) { globalThis.__incUsageApi && globalThis.__incUsageApi(); return next(); }
    const uid = wxUidFromReq(req);
    if (!uid) return res.status(401).json({ error: '未登录' });
    req.session.userId = uid;
    globalThis.__incUsageApi && globalThis.__incUsageApi();
    next();
  }

  /* 管理后台鉴权：仅 ADMIN_TOKEN 持有者可进入 */
  function requireAdmin(req, res, next) {
    if (!req.session.isAdmin) return res.status(401).json({ error: '未授权' });
    next();
  }

  /* 注册 */
  app.post('/api/register', wrap(async (req, res) => {
    const ip = req.ip;
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (username.length < 2 || username.length > 64) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(400).json({ error: '用户名需 2-64 个字符' }); }
    /* 允许邮箱形式用户名（老用户习惯把邮箱当用户名）+ 中文/字母/数字/_-/.@ */
    if (!/^[A-Za-z0-9_\-.@\u4e00-\u9fa5]+$/.test(username)) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(400).json({ error: '用户名包含非法字符' }); }
    if (password.length < 6) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(400).json({ error: '密码至少 6 位' }); }
    const exists = await db.userByName(username);
    if (exists) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(409).json({ error: '用户名已被占用' }); }
    /* 🔴 提前校验显示名占用（在 createUser 之前）——否则账号已创建才发现名字被占 → 409 但账号已落库，
     * 用户重试注册报"用户名已被占用"卡死（半创建账号）。最终一致性仍由 userSetDisplayName 内部兜底。 */
    const dn = String(req.body.display_name || '').trim();
    if (dn && dn.length >= 2 && dn.length <= 16 && /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(dn)) {
      const ph = await db.userByDisplayName(dn, 0);
      if (ph && String(ph.display_name).toLowerCase() === dn.toLowerCase()) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(409).json({ error: '该名字已被使用' }); }
    }
    const pw_hash = bcrypt.hashSync(password, 10);
    const uid = await db.createUser(username, pw_hash);
    if (!uid) return res.status(409).json({ error: '用户名已被占用' }); /* 云存储并发兜底 */
    /* 注册名若为邮箱格式（老用户习惯把邮箱当用户名），自动写入 email 字段（未验证），
     * 这样不绑定也能用该邮箱走「找回密码」流程 */
    if (EMAIL_RE.test(username)) await db.userBindEmail(uid, username.toLowerCase());
    /* 注册时可选直接取名（与 /api/me/name 同一套校验）；
     * 🔴 修复：不填时自动用【用户名清洗后的默认名】，不再登录后强制取名——同一用户微信端已取过名，网页端注册不应重复取。
     * 规则：取用户名 @ 前部分，过滤非法字符（仅留 中文/字母/数字/_/-），截 16 位；若清洗后仍 <2 位则用「用户+id」。 */
    let needName = false;
    if (dn) {
      if (dn.length >= 2 && dn.length <= 16 && /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(dn)) {
        /* 名字已提前查重（createUser 前）；这里 setDisplayName 内部仍有唯一性兜底，失败回落默认名 */
        if (!(await db.userSetDisplayName(uid, dn))) {
          if (!(await db.setDisplayNameWithRetry(uid, username))) needName = true;
        }
      } else {
        /* 非法名字不阻断注册，自动回落默认名 */
        if (!(await db.setDisplayNameWithRetry(uid, username))) needName = true;
      }
    } else {
      if (!(await db.setDisplayNameWithRetry(uid, username))) needName = true;
    }
    /* 🔴 数据初始化失败不报 500（账号已创建）——提示可登录，避免用户以为注册失败去重试撞"用户名已占用" */
    try { await db.profileSet(uid, JSON.stringify(defaultBag())); }
    catch (e) { console.warn('⚠️ 注册数据初始化失败（账号已创建）:', (e && e.message) || e); }
    req.session.userId = uid;
    req.session.username = username;
    authOk(ip);
    res.json({ ok: true, username, display_name: dn || '', need_name: needName });
  }));

  /* 登录：先校验密码，正确即放行并清零失败计数（不误伤终于输对的人）；
     只有密码错误时才累加限流，连续失败超阈值才返回 429。 */
  app.post('/api/login', wrap(async (req, res) => {
    const ip = req.ip;
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const u = await db.userByName(username) || await db.userByNameCI(username); /* 大小写不敏感（邮箱大小写常见） */
    if (u && u.pw_hash && bcrypt.compareSync(password, u.pw_hash)) {
      req.session.userId = u.id;
      req.session.username = u.username;
      authOk(ip);
      return res.json({ ok: true, username: u.username });
    }
    if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' });
    return res.status(401).json({ error: '用户名或密码错误' });
  }));

  /* 登出 */
  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  /* 当前用户（含邮箱/微信绑定状态，供设置页渲染；requireAuth 兼容网页 cookie 与小程序 Bearer token） */
  app.get('/api/me', requireAuth, wrap(async (req, res) => {
    const u = await db.userById(req.session.userId);
    /* 🔴 账号已删除（注销后旧 token/旧 session 仍有效）→ 401 → 前端自动重登/提示重新登录，
     * 防：删号后旧 token 继续读/写（幽灵数据），GET /api/data 还会自动重建默认 bag */
    if (!u) return res.status(401).json({ error: '账号不存在或已注销，请重新登录' });
    /* 🔴 孤儿检测：wx_ 已合并（openid 转走+清字段）→ 前端立即用新 token 重登（自愈） */
    if (u && /^wx_/.test(String(u.username || '')) && !u.wx_openid && u.orphaned) {
      return res.status(401).json({ error: '账号已合并到网页账号，请重新登录' });
    }
    res.json({
      username: u ? u.username : req.session.username,
      display_name: u ? (u.display_name || '') : '',
      need_name: u ? !u.display_name : false, /* 未取名 → 前端弹强制取名 */
      email: u ? (u.email || '') : '',
      email_verified: u ? !!u.email_verified : false,
      wechat: u ? (u.wechat || '') : '',
      is_wx: u ? /^wx_/.test(String(u.username || '')) : false, /* 🔴 微信自动注册账号 → 前端据此选 set-first（设初始密码）vs change（改密码） */
      pw_set: u ? !!u.pw_set : true, /* 已设过密码 → 改走 change（校验旧密码），未设 → set-first */
      wx_bound: u ? !!u.wx_openid : false, /* 🔴 是否已绑定微信登录（有 openid）——网页端/小程序端双向显示"已绑定微信" */
      web_bound: u ? !/^wx_/.test(String(u.username || '')) : false, /* 当前账号是否属于网页账号体系（非 wx_ 临时账号）；合并后微信登录直接进网页账号，此处为 true */
      web_bound_name: u && !/^wx_/.test(String(u.username || '')) ? u.username : '' /* 绑定卡显示当前网页账号 */
    });
  }));

  /* ---- 取名（显示名）：登录后必填、全局唯一、防注入 ---- */
  app.post('/api/me/name', requireAuth, wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    /* 字符规则：2-16 位，仅中文/字母/数字/下划线/连字符——天然排除 HTML 标签字符（<>"'&;）与脚本关键字 */
    if (name.length < 2 || name.length > 16) return res.status(400).json({ error: '名字需 2-16 个字符' });
    if (!/^[\u4e00-\u9fa5A-Za-z0-9_-]+$/.test(name)) return res.status(400).json({ error: '名字仅支持中文、字母、数字、下划线、连字符' });
    if (/^(admin|root|system|管理员)$/i.test(name)) return res.status(400).json({ error: '该名字不可用' });
    /* 唯一性：大小写不敏感比较（存储原样，查重用 lower） */
    const holder = await db.userByDisplayName(name, req.session.userId);
    if (holder && String(holder.display_name).toLowerCase() === name.toLowerCase()) return res.status(409).json({ error: '该名字已被使用' });
    const ok = await db.userSetDisplayName(req.session.userId, name);
    if (!ok) return res.status(500).json({ error: '设置失败，请重试' });
    res.json({ ok: true, display_name: name });
  }));

  /* ---- 用户系统 v1.2：邮箱绑定 / 找回密码 / 微信绑定 / 改密 ---- */

  /* ① 发送邮箱绑定验证码（登录态） */
  app.post('/api/email/send-code', requireAuth, wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    const holder = await db.userFindByEmail(email);
    if (holder && holder.id !== req.session.userId) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
    if (!smtpReady()) return res.status(503).json({ error: '验证码服务暂不可用，请联系管理员' });
    /* 🔴 重发冷却 60s（防连点轰炸） */
    const last = _codeCooldown.get(email);
    if (last && Date.now() - last < 60000) return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试' });
    const code = issueCode(email);
    const r = await sendCodeMail(email, code, 'bind');
    if (r.err) return res.status(500).json({ error: '验证码发送失败，请稍后再试' });
    _codeCooldown.set(email, Date.now());
    res.json({ ok: true, msg: '验证码已发送到 ' + email + '，10 分钟内有效' });
  }));

  /* ② 校验验证码并绑定邮箱 */
  app.post('/api/email/bind', requireAuth, wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    if (!checkCode(email, code)) return res.status(400).json({ error: '验证码错误或已过期' });
    const holder = await db.userFindByEmail(email);
    if (holder && holder.id !== req.session.userId) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
    await db.userBindEmail(req.session.userId, email);
    await db.userVerifyEmail(req.session.userId);
    res.json({ ok: true, email });
  }));

  /* ③ 找回密码：给已绑定邮箱发验证码（公开；不暴露邮箱是否注册；IP 限流防邮件轰炸） */
  app.post('/api/forgot/send-code', wrap(async (req, res) => {
    const ip = req.ip;
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' });
    if (!smtpReady()) return res.status(503).json({ error: '服务端未配置 SMTP，暂不支持找回密码' });
    const holder = await db.userFindByEmail(email);
    if (holder) { /* 仅当存在该邮箱才发码，未注册时静默（防枚举） */
      const code = issueCode(email);
      await sendCodeMail(email, code, 'reset');
    }
    res.json({ ok: true, msg: '若该邮箱已注册，验证码将发送至邮箱，10 分钟内有效' });
  }));

  /* ④ 重置密码（邮箱 + 验证码）——IP 限流 + 失败 5 次作废验证码（防爆破） */
  app.post('/api/forgot/reset', wrap(async (req, res) => {
    const ip = req.ip;
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' });
    if (!checkCode(email, code)) { authFail(ip); return res.status(400).json({ error: '验证码错误或已过期' }); }
    if (password.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const holder = await db.userFindByEmail(email);
    if (!holder) return res.status(404).json({ error: '该邮箱未绑定任何账号' });
    await db.userSetPassword(holder.id, bcrypt.hashSync(password, 10));
    authOk(ip);
    res.json({ ok: true, msg: '密码已重置，请用新密码登录' });
  }));

  /* ⑤ 绑定微信号（字符串形式；小程序 openid 绑定走另一接口，见下） */
  app.post('/api/wechat/bind', requireAuth, wrap(async (req, res) => {
    const wechat = String(req.body.wechat || '').trim();
    if (!wechat) return res.status(400).json({ error: '微信号不能为空' });
    if (wechat.length > 64) return res.status(400).json({ error: '微信号过长' });
    /* 🔴 wechat 全局唯一（网页端按微信号识别 wx_ 账号，必须唯一） */
    if (await db.wechatTaken(wechat, req.session.userId)) return res.status(409).json({ error: '该微信号已被其他账号使用' });
    try {
      await db.userSetWechat(req.session.userId, wechat);
    } catch (e) {
      /* PG 唯一索引冲突兜底 */
      return res.status(409).json({ error: '该微信号已被其他账号使用' });
    }
    res.json({ ok: true, wechat });
  }));

  /* ⑤b 解绑微信号（清空 wechat 字段；不影响小程序 openid 绑定） */
  app.post('/api/wechat/unbind', requireAuth, wrap(async (req, res) => {
    await db.userSetWechat(req.session.userId, '');
    res.json({ ok: true });
  }));

  /* ⑥ 小程序微信登录：wx.login 的 code 换 openid → 已有绑定则签发 token，未绑定则返回 openid 供绑定 */
  app.post('/api/wechat/login', wrap(async (req, res) => {
    if (!WX_APPID || !WX_SECRET) return res.status(503).json({ error: '服务端未配置 WX_APPID/WX_SECRET，暂不支持微信登录' });
    const code = String(req.body.code || '').trim();
    if (!code) return res.status(400).json({ error: '缺少 code' });
    let openid = '';
    try {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(WX_APPID)}&secret=${encodeURIComponent(WX_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
      const r = await fetch(url);
      const j = await r.json();
      if (j.errcode) {
        console.error('❌ code2session 失败：', j.errcode, j.errmsg);
        return res.status(400).json({ error: '微信登录失败：' + (j.errmsg || ('errcode ' + j.errcode)) });
      }
      openid = j.openid || '';
    } catch (e) {
      console.error('❌ 请求微信 code2session 异常：', e.message);
      return res.status(502).json({ error: '微信服务暂不可用，请稍后再试' });
    }
    if (!openid) return res.status(400).json({ error: '未获取到 openid' });
    const u = await db.userFindByOpenid(openid);
    if (u) return res.json({ ok: true, token: issueWxToken(u.id), username: u.username, display_name: u.display_name || '', need_name: !u.display_name, bound: true });
    /* 🔴 修复「退出再登录变新号」：历史遗留号 openid 为空（旧版 cloudUsersSave 吞错，openid 从未落盘）。
     * 按 username 前缀找回（注册名 = wx_ + openid 前 10 位）→ 补绑 openid 并登录旧号，不再每次注册新号。
     * 排除 orphaned（已被合并的号不复活，避免污染目标账号）。 */
    /* 🔴 找回历史 openid 空号（含 _N 序号变体）：wx_xxx / wx_xxx_2 / wx_xxx_3 ... 逐个探测
     * （orphaned 已排除——被合并的号不复活，避免污染目标账号） */
    const baseLegacy = 'wx_' + openid.slice(0, 10);
    let legacy = null;
    for (let i = 1; i <= 20; i++) {
      const cand = i === 1 ? baseLegacy : baseLegacy + '_' + i;
      const u = await db.userByName(cand);
      if (u && !u.wx_openid && /^wx_/.test(String(u.username || '')) && !u.orphaned) { legacy = u; break; }
      if (!u && i === 1) break; /* 基础名不存在则无需探测变体 */
    }
    if (legacy) {
      await db.userBindOpenid(legacy.id, openid);
      console.log('✅ 修复历史 openid 空账号并登录：', legacy.username);
      return res.json({ ok: true, token: issueWxToken(legacy.id), username: legacy.username, display_name: legacy.display_name || '', need_name: !legacy.display_name, bound: true, legacy_repaired: true });
    }
    /* 未绑定：自动注册一个新账号（微信一键登录直达，无需先有网页账号）。
     * 用户名取 wx_ + openid 片段（冲突时加序号）；密码随机不可知——用户之后可在设置页设密码，
     * 或通过「绑定网页账号」把 openid 关联到已有网页账号。 */
    let uname = 'wx_' + openid.slice(0, 10);
    let seq = 2;
    while (await db.userByName(uname)) uname = 'wx_' + openid.slice(0, 10) + '_' + (seq++);
    const randPw = crypto.randomBytes(16).toString('hex');
    const uid = await db.createUser(uname, bcrypt.hashSync(randPw, 10));
    if (!uid) return res.status(409).json({ error: '注册冲突，请重试' }); /* 云存储并发兜底 */
    await db.userBindOpenid(uid, openid);
    await db.profileSet(uid, JSON.stringify(defaultBag()));
    console.log('✅ 微信自动注册新账号：', uname);
    res.json({ ok: true, token: issueWxToken(uid), username: uname, display_name: '', need_name: true, bound: true, auto_registered: true });
  }));

  /* ⑥b 小程序绑定 web 账号：openid + 网页账号密码 → 关联并签发 token（IP 限流防爆破） */
  app.post('/api/wechat/bind-openid', wrap(async (req, res) => {
    const ip = req.ip;
    const openid = String(req.body.openid || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!openid) return res.status(400).json({ error: '缺少 openid' });
    const u = await db.userByName(username) || await db.userByNameCI(username); /* 大小写不敏感 */
    if (!u || !u.pw_hash || !bcrypt.compareSync(password, u.pw_hash)) {
      if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' });
      return res.status(401).json({ error: '账号或密码错误' });
    }
    authOk(ip);
    const holder = await db.userFindByOpenid(openid);
    if (holder && holder.id !== u.id) {
      /* openid 已被其他账号占用：仅当占用者是「微信自动注册的临时账号」（wx_ 前缀）时，
       * 视为可合并——把临时账号的数据并入目标账号、openid 转移，否则才是真冲突 */
      if (!/^wx_/.test(String(holder.username || ''))) return res.status(409).json({ error: '该微信已绑定其他账号' });
      const parse = s => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };
      const isDefaultBag = d => { /* 🔴 精确判定：有真实内容（非种子规则/有打卡/有事件/有复盘）就不是默认——_seed 标记在新用户保存后仍残留，不能只信它 */ const hasReal = (d && Array.isArray(d.rules) && d.rules.length > 0 && !(d.meta && d.meta._seed)) || (d && d.daily && Object.keys(d.daily).length > 0) || (d && d.events && d.events.length > 0) || (d && d.reviews && (Object.keys(d.reviews.day||{}).length > 0 || Object.keys(d.reviews.week||{}).length > 0)); return !hasReal; };
      const hData = parse(await db.profileGet(holder.id));
      const tData = parse(await db.profileGet(u.id));
      const hReal = !isDefaultBag(hData), tReal = !isDefaultBag(tData);
      if (!tReal && hReal) {
        /* 网页账号是空默认 → 直接用微信账号数据（真实数据保留） */
        const merged = Object.assign({}, hData);
        merged.daily = Object.assign({}, hData.daily || {}, tData.daily || {});
        merged.events = [...(hData.events || []), ...(tData.events || [])];
        await db.profileSet(u.id, JSON.stringify(merged));
      } else {
        const byId = list => { const m = {}; (list || []).forEach(x => { if (x && x.id) m[x.id] = x; }); return Object.values(m); };
        ['cats', 'levels', 'rules', 'tags', 'phases', 'resources'].forEach(k => {
          tData[k] = byId([...(hData[k] || []), ...(tData[k] || [])]);
        });
        const sr = hData.reviews || {}, tr = tData.reviews || {};
        tData.reviews = { day: Object.assign({}, sr.day || {}, tr.day || {}), week: Object.assign({}, sr.week || {}, tr.week || {}), month: Object.assign({}, sr.month || {}, tr.month || {}) };
        tData.retros = byId([...(hData.retros || []), ...(tData.retros || [])]);
        /* 🔴 daily 同天键级合并（修：不能再 Object.assign 覆盖 wx_ 真实打卡） */
      {
        const newDaily = Object.assign({}, hData.daily || {});
        Object.keys(tData.daily || {}).forEach(k => {
          const h = newDaily[k] || {};
          const t = tData.daily[k] || {};
          newDaily[k] = Object.assign({}, h, t, {
            checks: Object.assign({}, (h.checks || {}), (t.checks || {})),
            tags: Array.from(new Set([...(h.tags || []), ...(t.tags || [])]))
          });
        });
        tData.daily = newDaily;
      }
        tData.events = [...(hData.events || []), ...(tData.events || [])];
        await db.profileSet(u.id, JSON.stringify(tData));
      }
      await db.userBindOpenid(holder.id, null);
    }
    if (u.wx_openid && u.wx_openid !== openid) return res.status(409).json({ error: '该账号已绑定其他微信，请先解绑' });
    await db.userBindOpenid(u.id, openid);
    /* 🔴 修复：显示名继承——微信账号已有名字而网页账号空时，把名字带给网页账号（同一人不应重复取名） */
    if (holder && holder.display_name) {
      const tgt = await db.userById(u.id);
      if (tgt && !tgt.display_name) await db.userSetDisplayName(u.id, holder.display_name);
    }
    /* 🔴 修复：微信号继承——wx_ 账号设过微信号（供网页端接入用）而网页账号空时带给目标，
     * 否则合并后用户在网页端拿不到原微信号（唯一性：被其他账号占用则放弃继承） */
    if (holder && holder.wechat) {
      const tgt = await db.userById(u.id);
      if (tgt && !tgt.wechat && !(await db.wechatTaken(holder.wechat, u.id))) {
        await db.userSetWechat(u.id, holder.wechat);
      }
    }
    /* 🔴 清理孤儿：holder（wx_ 账号）openid 已转移，清空身份+随机密码+删 profile（防微信号占用/双份数据/可登录） */
    if (holder && holder.id !== u.id) await db.orphanWxAccount(holder.id);
    res.json({ ok: true, token: issueWxToken(u.id), username: u.username, display_name: (await db.userById(u.id)).display_name || '', need_name: !(await db.userById(u.id)).display_name, bound: true });
  }));

  /* ⑥c 保存订阅消息状态（小程序点击"开启每日提醒"后） */
  app.post('/api/wechat/subscribe', requireAuth, wrap(async (req, res) => {
    const tplId = String(req.body.tplId || '').trim();
    const enabled = req.body.enabled !== false;
    await db.subUpsert(req.session.userId, tplId, enabled);
    res.json({ ok: true, enabled });
  }));

  /* ============ 数据量限额 & 爱发电解锁（付费墙，默认关闭） ============
   * 默认不限制（LICENSE_ENABLED 未设 = 关闭，所有人一直免费）。
   * 启用：环境变量 LICENSE_ENABLED=true 时，数据量 > LICENSE_LIMIT_MB（默认 50MB）才锁定。
   * 解锁：爱发电 webhook（AFDIAN_TOKEN 验签）或管理员手动（/api/admin/unlock），解锁 30 天 */
  const LICENSE_ENABLED = process.env.LICENSE_ENABLED === '1' || process.env.LICENSE_ENABLED === 'true';
  const LICENSE_MB = Number(process.env.LICENSE_LIMIT_MB) || 50;
  const LICENSE_UNLOCK_DAYS = Number(process.env.LICENSE_UNLOCK_DAYS) || 30;
  app.get('/api/license/status', requireAuth, wrap(async (req, res) => {
    const u = await db.userById(req.session.userId);
    /* 开发者账户：永久免费（免付费墙） */
    if (u && Number(u.is_dev) === 1) {
      return res.json({ limited: false, reasons: [], unlockUntil: null, dev: true, usage: { rules: 0, dataBytes: 0, limitMB: LICENSE_MB, enabled: false } });
    }
    if (!LICENSE_ENABLED) {
      return res.json({ limited: false, reasons: [], unlockUntil: null, usage: { rules: 0, dataBytes: 0, limitMB: LICENSE_MB, enabled: false } });
    }
    const raw = await db.profileGet(req.session.userId);
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
    const rules = Array.isArray(data.rules) ? data.rules.length : 0;
    const dataBytes = raw ? Buffer.byteLength(raw, 'utf8') : 0;
    const unlocked = u.unlock_until && new Date(u.unlock_until).getTime() > Date.now();
    const reasons = [];
    if (dataBytes > LICENSE_MB * 1048576) reasons.push('数据量 ' + (dataBytes / 1048576).toFixed(1) + ' MB，超过免费额度 ' + LICENSE_MB + ' MB');
    res.json({
      limited: !unlocked && reasons.length > 0,
      reasons,
      unlockUntil: unlocked ? u.unlock_until : null,
      usage: { rules, dataBytes, limitMB: LICENSE_MB, enabled: true }
    });
  }));

  /* 爱发电支付回调（官方 Webhook 格式，2026-08 核实 guide.afdian.com/creator/developer）：
   *   请求体 = { ec, em, data: { type:'order', order:{ out_trade_no, user_id, plan_id, total_amount, remark, ... }, sign } }
   *   验签   = RSA-SHA256：sign_str = out_trade_no + user_id + plan_id + total_amount（依次拼接，无分隔符）
   *             data.sign 为 base64 编码的 RSA 签名，用爱发电官方公钥验证
   *   公钥   = 默认内置官方文档公钥；AFDIAN_PUBKEY 环境变量可覆盖（爱发电开发者后台可查）
   *   AFDIAN_TOKEN 现仅作功能开关（未配置视为未启用该功能）
   *   联调   = AFDIAN_DEBUG=1 时跳过验签（仅测试期用，跑通后务必关闭） */
  const AFDIAN_PUBKEY = (process.env.AFDIAN_PUBKEY || '').replace(/\\n/g, '\n')
    || '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y\nlYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS\n4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr\n8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf\njEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7\njRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW\nMQIDAQAB\n-----END PUBLIC KEY-----';
  app.post('/api/payment/afdian', wrap(async (req, res) => {
    if (!process.env.AFDIAN_TOKEN) { console.warn('💰 爱发电回调未启用：请配置环境变量 AFDIAN_TOKEN（爱发电 Webhook 开关）'); return res.json({ ec: 400, em: '未配置 AFDIAN_TOKEN' }); }
    try {
      const body = req.body || {};
      const data = body.data || {};
      const order = (typeof data.order === 'string' ? JSON.parse(data.order) : data.order) || {};
      const sign = String(data.sign || '');
      /* 联调开关仅限非生产环境（生产环境强制验签，防残留跳过验签被白嫖） */
      const DEBUG = process.env.AFDIAN_DEBUG === '1' && process.env.NODE_ENV !== 'production';
      if (!DEBUG) {
        /* RSA 验签：sign_str = out_trade_no+user_id+plan_id+total_amount */
        const signStr = [order.out_trade_no, order.user_id, order.plan_id, order.total_amount].join('');
        if (!signStr || !sign) return res.status(400).json({ ec: 400, em: '缺少订单数据或签名' });
        try {
          const verifier = crypto.createVerify('RSA-SHA256');
          verifier.update(signStr);
          if (!verifier.verify(AFDIAN_PUBKEY, Buffer.from(sign, 'base64'))) {
            console.warn('⚠️ 爱发电验签失败 | order=' + order.out_trade_no + ' | sign 前缀=' + sign.slice(0, 12));
            return res.status(403).json({ ec: 403, em: '验签失败' });
          }
        } catch (ve) {
          console.warn('⚠️ 爱发电验签异常：', ve.message);
          return res.status(403).json({ ec: 403, em: '验签失败' });
        }
      } else {
        console.warn('  → AFDIAN_DEBUG=1 已忽略验签（联调模式，请尽快关闭）');
      }
      /* 备注找用户；幂等：同一订单只解锁一次（orderSeen），重复推送直接返回成功 */
      const remark = String(order.remark || '').trim(); /* 用户付款时备注填用户名 */
      if (!remark) return res.json({ ec: 200, em: 'ok（备注为空，未解锁）' });
      if (await db.orderSeen(order.out_trade_no)) return res.json({ ec: 200, em: 'ok（重复订单，已处理）' });
      /* 🔴 修复：金额校验——总金额必须 ≥ 解锁价（分），防止任意金额+备注用户名白嫖解锁。
       * total_amount 单位为分（爱发电文档）。AFDIAN_DEBUG=1 联调时跳过。 */
      const payFen = Number(order.total_amount);
      const MIN_FEN = Number(process.env.AFDIAN_MIN_FEN) || 100; /* 默认 ¥1 = 100 分，可按需调 */
      if (process.env.AFDIAN_DEBUG !== '1' && !(payFen > 0 && payFen >= MIN_FEN)) {
        console.warn(`💰 爱发电回调：金额不足（${payFen}分 < ${MIN_FEN}分）跳过解锁 | 备注=${remark.slice(0,20)}`);
        return res.json({ ec: 200, em: 'ok（金额不足，未解锁）' });
      }
      const u = await db.userByName(remark);
      if (!u) { console.warn('💰 爱发电回调：备注「' + remark.replace(/[\r\n]/g, ' ').slice(0, 40) + '」未匹配到用户'); return res.json({ ec: 200, em: '未找到用户（付款备注需填用户名）' }); }
      const cur = u.unlock_until ? new Date(u.unlock_until).getTime() : 0;
      const until = new Date(Math.max(cur, Date.now()) + LICENSE_UNLOCK_DAYS * 86400000).toISOString();
      await db.userUnlock(u.id, until);
      await db.orderMark(order.out_trade_no, 'afdian', u.id, order.total_amount);
      console.log(`💰 爱发电回调：用户 ${u.username} 解锁至 ${until.slice(0, 10)}（订单 ${order.out_trade_no}）`);
      res.json({ ec: 200, em: 'ok' });
    } catch (e) { console.warn('⚠️ 爱发电回调处理失败：', e.message); res.json({ ec: 500, em: 'error' }); }
  }));

  /* 管理员手动解锁（备用通道）：POST /api/admin/unlock { username, days } */
  app.post('/api/admin/unlock', wrap(async (req, res) => {
    if (!ADMIN_TOKEN || (req.headers.authorization || '').replace('Bearer ', '') !== ADMIN_TOKEN) return res.status(401).json({ error: '未授权' });
    const username = String(req.body.username || '').trim();
    const days = Math.max(1, Math.min(3650, Number(req.body.days) || LICENSE_UNLOCK_DAYS));
    const u = await db.userByName(username);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    const until = new Date(Date.now() + days * 86400000).toISOString();
    await db.userUnlock(u.id, until);
    res.json({ ok: true, username, unlockUntil: until });
  }));

  /* ---- 定时任务入口（云函数定时触发器调用，解决缩容0下常驻定时器失效）----
   * 用法：云开发控制台 → 云函数 → rootosCron → 定时触发器（cron 表达式）
   *   每天 20:00：0 0 20 * * * *   → POST /api/cron/remind
   *   每天 00:10：0 10 0 * * * *   → POST /api/cron/backup
   * 鉴权：Authorization: Bearer <ADMIN_TOKEN> */
  app.post('/api/cron/remind', wrap(async (req, res) => {
    if (!ADMIN_TOKEN || (req.headers.authorization || '').replace('Bearer ', '') !== ADMIN_TOKEN) return res.status(401).json({ error: '未授权' });
    const before = Date.now();
    try { await sendReminders(); res.json({ ok: true, ms: Date.now() - before }); }
    catch (e) { console.warn('⚠️ cron/remind 失败：', e && e.message); res.json({ ok: false, error: e && e.message || 'remind failed' }); }
  }));
  app.post('/api/cron/backup', wrap(async (req, res) => {
    if (!ADMIN_TOKEN || (req.headers.authorization || '').replace('Bearer ', '') !== ADMIN_TOKEN) return res.status(401).json({ error: '未授权' });
    try { await runAutoBackup(); res.json({ ok: true }); }
    catch (e) { console.warn('⚠️ cron/backup 失败：', e && e.message); res.json({ ok: false, error: e && e.message || 'backup failed' }); }
  }));

  /* 导出全部用户数据（删库前保全）：ADMIN_TOKEN（Bearer）鉴权，返回完整 users + profiles */
  app.get('/api/admin/export-users', wrap(async (req, res) => {
    if (!ADMIN_TOKEN || (req.headers.authorization || '').replace('Bearer ', '') !== ADMIN_TOKEN) return res.status(401).json({ error: '未授权' });
    const users = await db.adminUsers();
    const out = {
      at: new Date().toISOString(),
      app: 'rootos-webapp',
      diag: {
        usePg: db.USE_PG,
        useCloudStorage: db.USE_CLOUD_STORAGE,
        cloudEnv: db.CLOUD_ENV || '(空)',
        hasCloudCred: !!(process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY) || !!process.env.TENCENTCLOUD_SESSIONTOKEN,
        cloudStorageFlag: process.env.CLOUD_STORAGE || '(未设)',
        sessionToken: !!process.env.TENCENTCLOUD_SESSIONTOKEN, /* 容器自动注入的临时凭证是否存在 */
        hasDbUrl: !!process.env.DATABASE_URL,
        dbConnected: db.isConnected(),
        nodeEnv: process.env.NODE_ENV || ''
      },
      count: users.length,
      users: users.map(u => ({
        id: u.id, username: u.username, display_name: u.display_name || '',
        email: u.email || '', wechat: u.wechat || '',
        is_dev: u.is_dev, created_at: u.created_at,
        profile: (() => { try { return JSON.parse(u.data || '{}'); } catch (e) { return {}; } })()
      }))
    };
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', 'attachment; filename="rootos-full-export-' + new Date().toISOString().slice(0, 10) + '.json"');
    res.send(JSON.stringify(out, null, 2));
  }));

  /* 🔴 清空全部用户数据（重新上架前）：必须传 confirm='DELETE-ALL' 二次确认，防误触。
   * 鉴权用 ADMIN_TOKEN（Bearer），与导出/inject 一致（requireAdmin 是 session 鉴权，脚本/curl 用不了） */
  app.post('/api/admin/wipe-users', wrap(async (req, res) => {
    if (!ADMIN_TOKEN || (req.headers.authorization || '').replace('Bearer ', '') !== ADMIN_TOKEN) return res.status(401).json({ error: '未授权' });
    if (String((req.body && req.body.confirm) || '') !== 'DELETE-ALL') return res.status(400).json({ error: '需传 confirm=DELETE-ALL 二次确认' });
    const n = await db.wipeAllUsers();
    console.log('🗑️ 已清空全部用户数据：', n, '个账号（重新上架前清理）');
    res.json({ ok: true, deleted: n });
  }));

  /* ---- 数据备份（全库快照存 backups 表） ---- */
  app.get('/api/admin/backups', requireAdmin, wrap(async (req, res) => {
    const list = await db.backupList(Number(req.query.limit) || 10);
    res.json({ ok: true, keep: BACKUP_KEEP, cos: { enabled: !!CLOUD_ENV, envId: CLOUD_ENV }, list });
  }));
  /* 立即备份（管理员手动触发） */
  app.post('/api/admin/backup', requireAdmin, wrap(async (req, res) => {
    await runAutoBackup();
    const list = await db.backupList(5);
    res.json({ ok: true, list });
  }));
  /* 【方案3迁移】一键把 PG profiles 表 → 云存储（幂等，可重复执行）。
   * 仅 CLOUD_STORAGE=1 且 DATABASE_URL 可用时提供。迁移后 profiles 表数据保留作备份。 */
  app.post('/api/admin/migrate-profiles', requireAdmin, wrap(async (req, res) => {
    if (!db.USE_CLOUD_STORAGE) return res.status(400).json({ error: '未启用云存储引擎（环境变量 CLOUD_STORAGE=1）' });
    if (!process.env.DATABASE_URL) return res.status(400).json({ error: '无 DATABASE_URL（旧 PG 连接串），无法读取待迁移数据' });
    const { Pool } = require('pg');
    const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
    try {
      const r = await pg.query('SELECT user_id, data, updated_at FROM profiles ORDER BY user_id');
      const rows = r.rows;
      let ok = 0, fail = 0, firstErr = '';
      const cloudbase = require('@cloudbase/node-sdk');
      const app0 = cloudbase.init({
        env: CLOUD_ENV,
        secretId: process.env.TENCENTCLOUD_SECRETID || undefined,
        secretKey: process.env.TENCENTCLOUD_SECRETKEY || undefined,
        sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN || undefined,
        accessKey: process.env.CLOUDBASE_APIKEY || undefined
      });
      for (const row of rows) {
        try {
          /* 健壮日期解析：兼容 Date 对象 / ISO 串 / 'YYYY-MM-DD HH:MM:SS'（pg 各版本返回格式不同），失败兜底用当前时间 */
          let updatedAt = new Date().toISOString();
          if (row.updated_at) {
            const dv = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
            if (!isNaN(dv.getTime())) updatedAt = dv.toISOString();
            else {
              const s = String(row.updated_at).replace(' ', 'T');
              const d2 = new Date(/Z$/.test(s) ? s : s + 'Z');
              if (!isNaN(d2.getTime())) updatedAt = d2.toISOString();
            }
          }
          await app0.uploadFile({
            cloudPath: 'profiles/' + row.user_id + '.json',
            fileContent: Buffer.from(JSON.stringify({ data: row.data, updatedAt }), 'utf8')
          });
          ok++;
        } catch (e) {
          fail++;
          if (!firstErr) firstErr = e.message;
        }
      }
      res.json({ ok: true, migrated: ok, failed: fail, firstErr: firstErr || null });
    } finally {
      await pg.end();
    }
  }));
  /* 迁移诊断：返回当前代码版本 + env 状态 + 待迁移数据的真实形态（排障用，不需点迁移按钮） */
  app.get('/api/admin/migrate-diag', requireAdmin, wrap(async (req, res) => {
    const out = {
      commitHint: '本构建代码日期特征：迁移接口含【健壮日期解析】(d98cd4f)',
      cloudStorage: db.USE_CLOUD_STORAGE ? 'on' : 'off',
      cloudEnv: CLOUD_ENV || '(未探测到)',
      hasDbUrl: !!process.env.DATABASE_URL,
      pgSamples: []
    };
    if (process.env.DATABASE_URL) {
      try {
        const { Pool } = require('pg');
        const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
        const r = await pg.query('SELECT user_id, updated_at FROM profiles ORDER BY user_id LIMIT 3');
        out.pgSamples = r.rows.map(x => ({
          user_id: x.user_id,
          type: x.updated_at === null ? 'null' : typeof x.updated_at,
          isDate: x.updated_at instanceof Date,
          value: x.updated_at === null ? null : (x.updated_at instanceof Date ? x.updated_at.toISOString() : String(x.updated_at))
        }));
        await pg.end();
      } catch (e) { out.pgErr = e.message; }
    }
    res.json(out);
  }));
  /* 下载某份备份（完整 JSON，含所有用户数据） */
  app.get('/api/admin/backups/:id', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    const snap = await db.backupGet(id);
    if (snap === null) return res.status(404).json({ error: '备份不存在' });
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', 'attachment; filename="rootos-backup-' + id + '.json"');
    res.send(snap);
  }));

  /* ---- 开发者账户（免付费墙 + 可登录管理后台） ---- */

  /* 开发者账号登录后台：用户名+密码+is_dev=1 → admin session（开发者用自己账号直接进 admin） */
  app.post('/api/admin/login-dev', wrap(async (req, res) => {
    if (authFail(req.ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' });
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const u = await db.userByName(username);
    if (!u || Number(u.is_dev) !== 1) { authFail(req.ip); return res.status(401).json({ error: '非开发者账号' }); }
    if (!u || !u.pw_hash || !bcrypt.compareSync(password, u.pw_hash)) { authFail(req.ip); return res.status(401).json({ error: '密码错误' }); }
    authOk(req.ip);
    req.session.isAdmin = true;
    res.json({ ok: true, username });
  }));

  /* 设置/取消开发者（ADMIN_TOKEN 保护）：POST /api/admin/set-dev { username, dev }
   * 支持大小写不敏感匹配（微信自动注册号 wx_ 前缀场景友好） */
  app.post('/api/admin/set-dev', wrap(async (req, res) => {
    if (!ADMIN_TOKEN || (req.headers.authorization || '').replace('Bearer ', '') !== ADMIN_TOKEN) return res.status(401).json({ error: '未授权' });
    const username = String(req.body.username || '').trim();
    const dev = req.body.dev !== false;
    let u = await db.userByName(username);
    if (!u) u = await db.userByNameCI(username);
    if (!u) return res.status(404).json({ error: '用户不存在——去用户列表搜索确认正确用户名（微信一键登录自动注册的是 wx_ 开头）' });
    await db.userSetDev(u.id, dev);
    res.json({ ok: true, username: u.username, dev, msg: dev ? '已设为开发者（免付费墙+可登录后台）' : '已取消开发者' });
  }));

  /* 注入规划数据（ADMIN_TOKEN 保护）：POST /api/admin/inject-plan { username, plan, mode }
   * plan = 完整 bag JSON（字符串）；mode = merge（合并，默认）| overwrite（覆盖全部） */
  app.post('/api/admin/inject-plan', wrap(async (req, res) => {
    if (!ADMIN_TOKEN || (req.headers.authorization || '').replace('Bearer ', '') !== ADMIN_TOKEN) return res.status(401).json({ error: '未授权' });
    const username = String(req.body.username || '').trim();
    const u = await db.userByName(username);
    if (!u) return res.status(404).json({ error: '用户不存在' });
    let plan = req.body.plan;
    if (typeof plan === 'string') { try { plan = JSON.parse(plan); } catch (e) { return res.status(400).json({ error: 'plan 不是合法 JSON' }); } }
    if (!plan || typeof plan !== 'object') return res.status(400).json({ error: 'plan 无效' });
    const raw = await db.profileGet(u.id);
    let cur = {};
    try { cur = JSON.parse(raw || '{}'); } catch (e) { cur = {}; }
    if (String(req.body.mode) === 'overwrite') {
      cur = Object.assign({}, cur, plan);
    } else {
      /* merge：数组类按 id 去重追加，标量以模板为准（保留用户已有数据） */
      const mergeArr = (key, idKey) => {
        const src = Array.isArray(plan[key]) ? plan[key] : [];
        const dst = Array.isArray(cur[key]) ? cur[key] : [];
        const seen = new Set(dst.map(x => x && x[idKey]));
        src.forEach(x => { if (x && !seen.has(x[idKey])) { dst.push(x); seen.add(x[idKey]); } });
        return dst;
      };
      cur.rules = mergeArr('rules', 'id');
      cur.phases = mergeArr('phases', 'id');
      cur.resources = mergeArr('resources', 'id');
      cur.retros = mergeArr('retros', 'id');
      if (!Array.isArray(cur.tags)) cur.tags = plan.tags || [];
      if (!Array.isArray(cur.cats)) cur.cats = plan.cats || [];
      if (!Array.isArray(cur.levels)) cur.levels = plan.levels || [];
      if (!cur.meta) cur.meta = Object.assign({}, plan.meta || {}, { injected: true });
      else cur.meta.injected = true;
      /* 🔴 daily 键级合并（恢复数据不丢打卡）：同天 checks/tags 并集、本地有值字段优先 */
      {
        const newDaily = Object.assign({}, cur.daily || {});
        Object.keys(plan.daily || {}).forEach(k => {
          const s = newDaily[k] || {};
          const t = plan.daily[k] || {};
          newDaily[k] = Object.assign({}, s, t, {
            checks: Object.assign({}, (s.checks || {}), (t.checks || {})),
            tags: Array.from(new Set([...(s.tags || []), ...(t.tags || [])]))
          });
        });
        cur.daily = newDaily;
      }
      /* events 按 id 去重合并；reviews 键级合并 */
      cur.events = mergeArr('events', 'id');
      {
        const sr = plan.reviews || {}, cr = cur.reviews || {};
        cur.reviews = { day: Object.assign({}, sr.day || {}, cr.day || {}), week: Object.assign({}, sr.week || {}, cr.week || {}), month: Object.assign({}, sr.month || {}, cr.month || {}) };
      }
    }
    await db.profileSet(u.id, JSON.stringify(cur));
    res.json({ ok: true, username, mode: String(req.body.mode) === 'overwrite' ? 'overwrite' : 'merge',
      counts: { rules: (cur.rules||[]).length, phases: (cur.phases||[]).length, resources: (cur.resources||[]).length } });
  }));

  /* 🔴 诊断：inject-plan 失败时返回真实错误（便于定位云存储/逻辑问题） */
  app.use('/api/admin/inject-plan', (err, req, res, next) => {
    console.error('❌ inject-plan 错误:', err && err.stack || err);
    /* 🔴 生产隐藏 detail（诊断已结束） */
    if (!res.headersSent) {
      if (process.env.NODE_ENV !== 'production') res.status(500).json({ error: '服务器内部错误', detail: (err && err.message) || String(err) });
      else res.status(500).json({ error: '服务器内部错误' });
    }
  });
  /* ⑦ 修改密码（需旧密码） */
  app.post('/api/password/change', requireAuth, wrap(async (req, res) => {
    const oldPw = String(req.body.old || '');
    const nextPw = String(req.body.next || '');
    const u = await db.userById(req.session.userId);
    if (!u || !u.pw_hash || !bcrypt.compareSync(oldPw, u.pw_hash)) return res.status(400).json({ error: '当前密码不正确' });
    if (nextPw.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    await db.userSetPassword(u.id, bcrypt.hashSync(nextPw, 10));
    res.json({ ok: true, msg: '密码已更新' });
  }));

  /* ⑦b 微信自动注册账号首次设置密码（随机密码不可知，无需旧密码）——
   * 设置后该 wx_ 账号即可被网页端「接入微信账号」用 账号+密码 合并 */
  app.post('/api/password/set-first', requireAuth, wrap(async (req, res) => {
    const u = await db.userById(req.session.userId);
    if (!u) return res.status(401).json({ error: '未登录' });
    if (!/^wx_/.test(String(u.username || ''))) return res.status(400).json({ error: '该功能仅限微信自动注册账号设置初始密码' });
    /* 🔴 安全：已设过密码 → 需带 reset:true（前端二次确认）才允许重设——
     * 微信登录态本身即身份验证（能登录=本人），忘密码也可重设；不带标记则拒绝防误触 */
    if (u.pw_set && !req.body.reset) return res.status(400).json({ error: '已设置过密码，如需重设请确认' });
    const nextPw = String(req.body.next || '');
    if (nextPw.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    if (nextPw.length > 64) return res.status(400).json({ error: '密码过长' });
    await db.userSetPassword(u.id, bcrypt.hashSync(nextPw, 10));
    res.json({ ok: true, msg: '密码已设置，可凭 账号+' + '密码 从网页端接入合并' });
  }));


  /* ⑧ 绑定已有网页账号（v1.4：微信自动注册账号 → 并入已有网页账号，数据合并）
   * 场景：用户先用微信登录生成了 wx_ 账号，想把数据并到原来的网页账号（如邮箱注册的），
   * 之后微信登录直接进网页账号。 */
  app.post('/api/account/merge-web', requireAuth, wrap(async (req, res) => {
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');
    const target = await db.userByName(username);
    if (!target || !target.pw_hash || !bcrypt.compareSync(password, target.pw_hash)) return res.status(401).json({ error: '账号或密码错误' });
    if (target.id === req.session.userId) return res.status(400).json({ error: '当前已是该账号，无需绑定' });
    const cur = await db.userById(req.session.userId);
    /* 🔴 历史遗留号 openid 空（旧版假成功时代注册）→ 提示先重登（重登会按 openid 前缀自动补绑），
     * 而不是笼统报「没有微信绑定」让用户困惑 */
    if (!cur || !cur.wx_openid) return res.status(400).json({ error: '当前账号未绑定微信，请先「退出登录」再重新登录一次（将自动绑定微信），然后重试绑定' });
    /* 只禁止：openid 已被【其他账号】绑定。当前账号自己持有 openid 是正常情况（就是要转给目标账号） */
    const holder = await db.userFindByOpenid(cur.wx_openid);
    if (holder && holder.id !== req.session.userId && holder.id !== target.id) return res.status(409).json({ error: '该微信已绑定其他账号' });
    /* 数据合并：🔴 修复方向 bug——不能"网页账号优先+空才补"：
     * 新账号的 profileGet 会返回 defaultBag（SEED 规则非空），导致 wx_ 真实数据被默认值顶掉。
     * 正确：按「非默认」判断——有真实数据的一方保留，双方都有则结构字段 id 级并集、daily/events 合并。 */
    const parse = s => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };
    const isDefaultBag = d => (d && d.meta && d.meta._seed) || !d.rules || !Array.isArray(d.rules) || d.rules.length === 0; /* 🔴 _seed 标记优先：defaultBag 恒含种子规则，仅判 length 会误判临时账号为真实数据 */
    const curData = parse(await db.profileGet(req.session.userId));
    const tgtData = parse(await db.profileGet(target.id));
    const curReal = !isDefaultBag(curData), tgtReal = !isDefaultBag(tgtData);
    if (!tgtReal && curReal) {
      /* 目标账号是空默认 → 直接用微信账号数据（真实数据保留） */
      const merged = Object.assign({}, curData);
      merged.daily = Object.assign({}, curData.daily || {}, tgtData.daily || {});
      merged.events = [...(curData.events || []), ...(tgtData.events || [])];
      await db.profileSet(target.id, JSON.stringify(merged));
    } else {
      /* 双方都有数据（或只有目标有）→ 结构字段 id 级并集（本地空补对方，非空保留双方），daily/events 合并 */
      const byId = list => { const m = {}; (list || []).forEach(x => { if (x && x.id) m[x.id] = x; }); return Object.values(m); };
      ['cats', 'levels', 'rules', 'tags', 'phases', 'resources'].forEach(k => {
        tgtData[k] = byId([...(curData[k] || []), ...(tgtData[k] || [])]);
      });
      /* reviews 键级合并；retros 按 id */
      const sr = curData.reviews || {}, tr = tgtData.reviews || {};
      tgtData.reviews = { day: Object.assign({}, sr.day || {}, tr.day || {}), week: Object.assign({}, sr.week || {}, tr.week || {}), month: Object.assign({}, sr.month || {}, tr.month || {}) };
      tgtData.retros = byId([...(curData.retros || []), ...(tgtData.retros || [])]);
      /* 🔴 修复 daily 合并：同天键级合并（checks/tags 并集+本地有值优先），不能再用 Object.assign 整键覆盖——曾导致 wx_ 真实打卡被网页账号空 daily 覆盖（数据"没了"） */
      {
        const newDaily = Object.assign({}, curData.daily || {});
        Object.keys(tgtData.daily || {}).forEach(k => {
          const s = newDaily[k] || {};
          const t = tgtData.daily[k] || {};
          newDaily[k] = Object.assign({}, s, t, {
            checks: Object.assign({}, (s.checks || {}), (t.checks || {})),
            tags: Array.from(new Set([...(s.tags || []), ...(t.tags || [])]))
          });
        });
        tgtData.daily = newDaily;
      }
      tgtData.events = [...(curData.events || []), ...(tgtData.events || [])];
      await db.profileSet(target.id, JSON.stringify(tgtData));
    }
    /* openid 转给目标账号；当前 wx_ 账号解除（下次微信登录直接进目标账号） */
    if (target.wx_openid && target.wx_openid !== cur.wx_openid) return res.status(409).json({ error: '该账号已绑定其他微信，请先解绑' });
    await db.userBindOpenid(target.id, cur.wx_openid);
    await db.userBindOpenid(req.session.userId, null);
    /* 🔴 修复：显示名继承——微信账号有名字而网页账号空时，把名字带给网页账号（同一人不应重复取名） */
    if (cur.display_name && !target.display_name) await db.userSetDisplayName(target.id, cur.display_name);
    /* 🔴 微信号继承：wx_ 有微信号而目标空 → 带给目标 */
    if (cur.wechat && !target.wechat) {
      const taken = await db.wechatTaken(cur.wechat, target.id);
      if (!taken) await db.userSetWechat(target.id, cur.wechat);
    }
    /* 🔴 清理孤儿：wx_ 账号已合并，清空身份字段+随机密码+删 profile */
    await db.orphanWxAccount(req.session.userId);
    console.log('✅ 账号合并：', cur.username, '→', target.username);
    res.json({ ok: true, token: issueWxToken(target.id), username: target.username, display_name: (await db.userById(target.id)).display_name || '', need_name: !(await db.userById(target.id)).display_name, msg: '已绑定并合并数据' });
  }));

  /* ⑧b 网页端接入微信账号（反向合并）：网页账号当前登录 → 输入 wx_ 账号 + 密码 → 微信数据并入网页账号。
   * 场景：用户网页端用邮箱注册，之前在小程序用过 wx_ 账号（设过密码），现在想把两边数据合在一起。 */
  app.post('/api/account/attach-wx', requireAuth, wrap(async (req, res) => {
    try {
    /* 🔴 用户期望的逻辑：网页端输入【微信号 + 密码】接入小程序端 wx_ 账号
     * 微信号是 wx_ 账号在「我的」里设置的友好登录标识（替代 wx_xxx 不友好的系统账号） */
    const wechat = String((req.body || {}).wechat || '').trim();
    const password = String((req.body || {}).password || '');
    if (!wechat) return res.status(400).json({ error: '请输入小程序端微信号' });
    if (!password) return res.status(400).json({ error: '请输入小程序端密码' });
    /* 🔴 关键：微信号不能为空（用户必须先在小程序端设置过才能接入）——这是身份锚点 */
    const wx = await db.userByWechat(wechat);
    if (!wx) return res.status(401).json({ error: '未找到该微信号对应的小程序账号（请先在小程序端「我的」设置微信号+密码）' });
    if (!/^wx_/.test(String(wx.username || ''))) return res.status(401).json({ error: '该微信号不是小程序自动注册账号' });
    if (!wx || !wx.pw_hash || !bcrypt.compareSync(password, wx.pw_hash)) return res.status(401).json({ error: '密码错误' });
    if (wx.id === req.session.userId) return res.status(400).json({ error: '当前已是该账号，无需绑定' });
    if (!wx.wx_openid) return res.status(400).json({ error: '该小程序账号未绑定微信登录，无法接入' });
    const target = await db.userById(req.session.userId);
    /* 数据合并：与 merge-web 同一套（目标=网页账号，源=wx_ 账号） */
    const parse = s => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };
    const isDefaultBag = d => (d && d.meta && d.meta._seed) || !d.rules || !Array.isArray(d.rules) || d.rules.length === 0;
    const srcData = parse(await db.profileGet(wx.id));
    const tgtData = parse(await db.profileGet(target.id));
    const srcReal = !isDefaultBag(srcData), tgtReal = !isDefaultBag(tgtData);
    if (!tgtReal && srcReal) {
      const merged = Object.assign({}, srcData);
      merged.daily = Object.assign({}, srcData.daily || {}, tgtData.daily || {});
      merged.events = [...(srcData.events || []), ...(tgtData.events || [])];
      await db.profileSet(target.id, JSON.stringify(merged));
    } else {
      const byId = list => { const m = {}; (list || []).forEach(x => { if (x && x.id) m[x.id] = x; }); return Object.values(m); };
      ['cats', 'levels', 'rules', 'tags', 'phases', 'resources'].forEach(k => {
        tgtData[k] = byId([...(srcData[k] || []), ...(tgtData[k] || [])]);
      });
      const sr = srcData.reviews || {}, tr = tgtData.reviews || {};
      tgtData.reviews = { day: Object.assign({}, sr.day || {}, tr.day || {}), week: Object.assign({}, sr.week || {}, tr.week || {}), month: Object.assign({}, sr.month || {}, tr.month || {}) };
      tgtData.retros = byId([...(srcData.retros || []), ...(tgtData.retros || [])]);
      const newDaily = Object.assign({}, srcData.daily || {});
      Object.keys(tgtData.daily || {}).forEach(k => {
        const s = newDaily[k] || {}, t = tgtData.daily[k] || {};
        newDaily[k] = Object.assign({}, s, t, { checks: Object.assign({}, (s.checks || {}), (t.checks || {})), tags: Array.from(new Set([...(s.tags || []), ...(t.tags || [])])) });
      });
      tgtData.daily = newDaily;
      tgtData.events = [...(srcData.events || []), ...(tgtData.events || [])];
      await db.profileSet(target.id, JSON.stringify(tgtData));
    }
    /* openid 转给网页账号；wx_ 账号解除绑定（下次微信登录直接进网页账号） */
    /* 🔴 防覆盖：target 已绑另一个微信 → 拒绝（避免切断原微信登录无提示） */
    if (target.wx_openid && target.wx_openid !== wx.wx_openid) {
      return res.status(409).json({ error: '该账号已绑定其他微信，请先解绑或联系管理员' });
    }
    await db.userBindOpenid(target.id, wx.wx_openid);
    await db.userBindOpenid(wx.id, null);
    if (wx.display_name && !target.display_name) await db.userSetDisplayName(target.id, wx.display_name);
    /* 🔴 微信号继承：wx_ 有微信号而目标空 → 带给目标（用户熟悉的微信号不丢失；orphan 会清 wx_ 的） */
    if (wx.wechat && !target.wechat) {
      const taken = await db.wechatTaken(wx.wechat, target.id);
      if (!taken) await db.userSetWechat(target.id, wx.wechat);
    }
    /* 🔴 清理孤儿：wx_ 账号已合并，清空身份字段+随机密码+删 profile（防微信号占用/双份数据/可登录） */
    await db.orphanWxAccount(wx.id);
    console.log('✅ 网页接入微信：', wx.username, '→', target.username);
    res.json({ ok: true, token: issueWxToken(target.id), username: target.username, display_name: (await db.userById(target.id)).display_name || '', msg: '已接入并合并数据' });
    } catch (e) {
      console.error('❌ attach-wx 详细错误：', e && e.stack || e);
      /* 🔴 生产隐藏 detail（诊断已结束） */
      if (!res.headersSent) {
        if (process.env.NODE_ENV !== 'production') res.status(500).json({ error: '服务器内部错误', detail: (e && e.message) || String(e) });
        else res.status(500).json({ error: '服务器内部错误' });
      }
    }
  }));

  /* 当前用户自己的失败模式分析（崩溃最多的定式 + 支链恢复率），人人可见，仅看自己 */
  app.get('/api/me/failure-analysis', requireAuth, wrap(async (req, res) => {
    const raw = await db.profileGet(req.session.userId);
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
    res.json(computeFailureAnalysis(data));
  }));

  /* 解析上传的文档（.docx/.txt/.md）→ 返回纯文本，供「规划·资源」导入收藏
   * 前端把文件读成 base64 传上来（避免 multipart 依赖），服务端解码后用 mammoth 抽 docx 文本 */
  app.post('/api/parse-doc', requireAuth, wrap(async (req, res) => {
    const filename = String(req.body.filename || '');
    const b64 = String(req.body.data || '');
    if (!b64) return res.status(400).json({ error: '文件内容为空' });
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (e) { return res.status(400).json({ error: '文件解码失败' }); }
    const lower = filename.toLowerCase();
    if (lower.endsWith('.docx')) {
      try {
        const mammoth = require('mammoth');
        const out = await mammoth.extractRawText({ buffer: buf });
        res.json({ text: out.value || '' });
      } catch (e) {
        res.status(500).json({ error: 'Word 解析失败：' + e.message });
      }
    } else {
      /* .txt / .md / 其它：按 UTF-8 文本处理 */
      res.json({ text: buf.toString('utf8') });
    }
  }));

  /* 读取数据 */
  /* 轻量版本探测：只返回数据更新时间（几字节），供前端 60s 轮询判断是否需要全量拉取，
   * 避免每次轮询都传整个 JSON 包（腾讯云按流量+读次数计费，这是降消耗的关键接口） */
  app.get('/api/data/meta', requireAuth, wrap(async (req, res) => {
    /* meta 探测用快速版（getFileInfo 秒级）：省全量下载流量；秒级误差只多拉一次不丢数据 */
    const updatedAt = await db.profileUpdatedAt(req.session.userId, false);
    res.json({ updatedAt: updatedAt || 0 });
  }));

  app.get('/api/data', requireAuth, wrap(async (req, res) => {
    /* 🔴 账号已删除（注销后旧 token）→ 401，防自动重建幽灵数据 */
    if (!(await db.userById(req.session.userId))) return res.status(401).json({ error: '账号不存在或已注销，请重新登录' });
    const raw = await db.profileGet(req.session.userId);
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
    if (!data || Object.keys(data).length === 0) {
      data = defaultBag();
      await db.profileSet(req.session.userId, JSON.stringify(data));
    }
    /* 多端同步：以服务器时钟为准，返回数据最后更新时间（供前端判断本地是否较新），
     * 避免依赖客户端时钟（设备时钟不一致会导致数据被静默覆盖）。
     * 🔴 用文件内毫秒（与 PUT 乐观锁同一精度）——秒级会导致 baseTs < curTs 恒成立 → 首次保存必 409。
     * 同时写入响应体 _updatedAt（云函数转发通道不透传 header，前端从 body 取） */
    const updatedAt = await db.profileUpdatedAt(req.session.userId, true);
    if (updatedAt) res.setHeader('X-Data-Updated', updatedAt);
    if (updatedAt) data._updatedAt = updatedAt;
    res.json(data);
  }));

  /* 保存数据（整包覆盖） */
  /* ---- 滥用防护：保存接口限流（防疯狂上传/包体炸弹） ---- */
  const _saveBuckets = new Map(); // userId -> { n, reset }
  const SAVE_PER_MIN = Number(process.env.SAVE_PER_MIN) || 30;
  const MAX_RULES_PER_USER = Number(process.env.MAX_RULES_PER_USER) || 500;
  const MAX_TAGS = 30, MAX_CATS = 30, MAX_LEVELS = 12, MAX_PHASES = 60;
  const MAX_RULE_TEXT = 200, MAX_CAT_NAME = 30, MAX_TAG_NAME = 20, MAX_PHASE_NAME = 120 /* 阶段复合目标，60 会截断 V4 规划 */, MAX_RESOURCE_BODY = 20000, MAX_RETRO_TEXT = 8000;
  function saveRateOk(uid) {
    const now = Date.now(), win = 60 * 1000;
    let b = _saveBuckets.get(uid);
    if (!b || now > b.reset) { b = { n: 0, reset: now + win }; _saveBuckets.set(uid, b); }
    b.n++;
    if (_saveBuckets.size > 5000) { for (const [k, v] of _saveBuckets) { if (now > v.reset) _saveBuckets.delete(k); } }
    return b.n <= SAVE_PER_MIN;
  }
  function trimStr(v, max) { return typeof v === 'string' ? v.slice(0, max) : v; }
  function sanitizeBag(d) {
    /* 字段长度裁剪 + 数量上限（防恶意灌水撑爆数据库） */
    const clean = { ...defaultBag(), ...d };
    if (clean.meta) {
      delete clean.meta.ghToken;
      /* 🔴 修复：一旦用户保存（写入真实数据），清除 _seed 默认标记——
       * 否则新用户改过规则后仍被 isDefaultBag 判为"临时账号"，绑定合并方向错乱 */
      delete clean.meta._seed;
    }
    if (Array.isArray(clean.rules)) {
      if (clean.rules.length > MAX_RULES_PER_USER) return { error: `规则数量超过上限 ${MAX_RULES_PER_USER}` };
      clean.rules = clean.rules.slice(0, MAX_RULES_PER_USER).map(r => ({
        ...r,
        t: trimStr(r.t || '', MAX_RULE_TEXT),
        micro: trimStr(r.micro || '', MAX_RULE_TEXT)
      }));
    }
    if (Array.isArray(clean.cats)) clean.cats = clean.cats.slice(0, MAX_CATS).map(c => ({ ...c, name: trimStr(c.name, MAX_CAT_NAME) }));
    if (Array.isArray(clean.tags)) clean.tags = clean.tags.slice(0, MAX_TAGS).map(t => ({ ...t, name: trimStr(t.name, MAX_TAG_NAME) }));
    if (Array.isArray(clean.levels)) clean.levels = clean.levels.slice(0, MAX_LEVELS);
    if (Array.isArray(clean.phases)) clean.phases = clean.phases.slice(0, MAX_PHASES).map(p => ({
      ...p, name: trimStr(p.name || '', MAX_PHASE_NAME), goal: trimStr(p.goal || '', MAX_PHASE_NAME)
    }));
    if (Array.isArray(clean.resources)) clean.resources = clean.resources.slice(0, 500).map(r => ({
      ...r, title: trimStr(r.title || '', 80), body: trimStr(r.body || '', MAX_RESOURCE_BODY)
    }));
    if (Array.isArray(clean.retros)) clean.retros = clean.retros.slice(0, 200).map(r => ({
      ...r, text: trimStr(r.text || '', MAX_RETRO_TEXT)
    }));
    if (Array.isArray(clean.events)) clean.events = clean.events.slice(-1500).map(e => ({
      ...e, text: trimStr(e.text || '', 300), retro: trimStr(e.retro || '', 300), ts: trimStr(e.ts || '', 40)
    }));
    /* 🔴 修复：daily 键白名单（防脏数据）——只保留 YYYY-MM-DD 日期键，文本/checks 限长 */
    if (clean.daily && typeof clean.daily === 'object') {
      const dk = /^\d{4}-\d{2}-\d{2}$/;
      const nd = {};
      Object.keys(clean.daily).slice(0, 4000).forEach(k => {
        if (!dk.test(k)) return;
        const rec = clean.daily[k] || {};
        const nr = { ...rec };
        if (typeof nr.note === 'string') nr.note = trimStr(nr.note, 500);
        if (typeof nr.sleep === 'number') nr.sleep = Math.max(0, Math.min(24, nr.sleep));
        if (rec.checks && typeof rec.checks === 'object') {
          const ck = {};
          Object.keys(rec.checks).slice(0, 2000).forEach(id => { ck[id] = !!rec.checks[id]; });
          nr.checks = ck;
        }
        if (Array.isArray(rec.tags)) nr.tags = rec.tags.slice(0, 50).map(t => trimStr(t, 30));
        nd[k] = nr;
      });
      clean.daily = nd;
    }
    /* reviews 文本限长 */
    if (clean.reviews && typeof clean.reviews === 'object') {
      const nr = { day: {}, week: {}, month: {} };
      ['day', 'week', 'month'].forEach(t => {
        const src = clean.reviews[t] || {};
        Object.keys(src).slice(0, 1000).forEach(k => { nr[t][k] = trimStr(src[k], 2000); });
      });
      clean.reviews = nr;
    }
    if (clean.meta && typeof clean.meta === 'object') {
      /* 🔴 修复：quickEvents 是【数组】（网页/小程序端一致：{type,label,color}[]）——
       * 原把数组当对象处理（Object.keys → '0','1'）→ 数据损坏 → 颜色/事件错乱。
       * 改为：数组 → 裁剪数量 + 每项字段裁剪 */
      if (Array.isArray(clean.meta.quickEvents)) {
        clean.meta.quickEvents = clean.meta.quickEvents.slice(0, 30).map(q => ({
          type: trimStr(q && q.type || '', 20),
          label: trimStr(q && q.label || '', 20),
          color: trimStr(q && q.color || '', 20)
        }));
      } else if (clean.meta.quickEvents && typeof clean.meta.quickEvents === 'object') {
        /* 兼容旧数据（对象形式）→ 转数组 */
        const qe = [];
        Object.keys(clean.meta.quickEvents).slice(0, 30).forEach(k => {
          const v = clean.meta.quickEvents[k];
          qe.push(typeof v === 'string' ? { type: k, label: v, color: '' } : v);
        });
        clean.meta.quickEvents = qe;
      }
    }
    return { ok: true, clean };
  }

  app.put('/api/data', requireAuth, wrap(async (req, res) => {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: '数据格式错误' });
    /* 🔴 用户存在性检查（与 GET /api/data 一致）：注销后旧 JWT 仍可 PUT → 防止重建幽灵 profile */
    if (!(await db.userById(req.session.userId))) return res.status(401).json({ error: '账号不存在，请重新登录' });
    /* 滥用防护：写入频率限流（每用户每分钟最多 N 次） */
    if (!saveRateOk(req.session.userId)) return res.status(429).json({ error: '写入过于频繁，请稍后再试' });
    /* 乐观锁（防双端同时写互相覆盖）：客户端带 baseTs = 它读取数据时的服务端 updated_at。
     * 服务端已比 baseTs 新 → 说明另一端的改动先落库了 → 返回 409 + 最新数据，前端合并后重试。
     * 安全加固：服务端已有数据（curTs>0）时，客户端必须带 baseTs 且 >= curTs 才允许覆盖——
     * baseTs=0（旧客户端/未读取服务端数据）不再放行，杜绝"用本地旧数据覆盖云端新数据"。 */
    const baseTs = Number(req.body._baseTs) || 0;
    delete req.body._baseTs;
    const curTsStr = await db.profileUpdatedAt(req.session.userId, true); /* 乐观锁：精确毫秒 */
    const curTs = curTsStr ? new Date(curTsStr).getTime() : 0;
    if (curTs > 0 && baseTs < curTs) {
      const raw = await db.profileGet(req.session.userId);
      let latest = {};
      try { latest = JSON.parse(raw || '{}'); } catch (e) { latest = {}; }
      return res.status(409).json({ error: '数据已在其他设备更新，已自动合并', latest, updatedAt: curTsStr });
    }
    const result = sanitizeBag(req.body);
    if (result.error) return res.status(400).json({ error: result.error });
    await db.profileSet(req.session.userId, JSON.stringify(result.clean));
    /* 返回最新 updatedAt，供小程序端更新乐观锁基准（_bagTs） */
    const after = await db.profileUpdatedAt(req.session.userId, true); /* 写后基准：精确毫秒 */
    res.json({ ok: true, updatedAt: after || null });
  }));

  /* 二维码生成（小程序「打开网页版」弹层用）：GET /api/qr?url=https://... → PNG
   * 限制仅本站域名（防被当钓鱼二维码生成器滥用） */
  app.get('/api/qr', wrap(async (req, res) => {
    const url = String(req.query.url || '').slice(0, 500);
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: '无效链接' });
    try {
      const u = new URL(url);
      const host = u.hostname;
      if (host !== req.hostname && !host.endsWith('.' + req.hostname)) return res.status(400).json({ error: '仅支持本站域名链接' });
    } catch (e) { return res.status(400).json({ error: '无效链接' }); }
    try {
      const QR = require('qrcode');
      const png = await QR.toBuffer(url, { width: 300, margin: 1 });
      res.set('Content-Type', 'image/png').send(png);
    } catch (e) {
      res.status(500).json({ error: '二维码生成失败' });
    }
  }));

  /* 站内公告：登录后两端弹窗展示（版本变化才弹）。内容维护在 public/notice.json，大版本更新改那里即可 */
  app.get('/api/notice', wrap(async (req, res) => {
    try {
      const fs = require('fs');
      const raw = fs.readFileSync(path.join(__dirname, 'public', 'notice.json'), 'utf8');
      res.json(JSON.parse(raw));
    } catch (e) {
      res.json({ version: '0', title: '', features: [] });
    }
  }));

  /* ---- 分享快照（v0.6：把规划生成链接，别人打开一键套用） ---- */

  /* 创建分享：把当前用户的规划结构（不含打卡/事件/复盘/笔记）存为公开只读快照，返回短链接
   * body.modules：可选数组，用户勾选要分享的模块（cats/levels/rules/tags/phases/resources），默认全部 */
  app.post('/api/share/create', requireAuth, wrap(async (req, res) => {
    const raw = await db.profileGet(req.session.userId);
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
    if (!Array.isArray(data.rules) || !data.rules.length) return res.status(400).json({ error: '当前没有可分享的规划' });
    /* 只分享结构字段，不含运行数据（daily/events）与隐私内容（reviews 复盘/retros 随笔）；
     * resources 规划资源按用户勾选决定是否包含 */
    const mods = Array.isArray(req.body.modules) && req.body.modules.length
      ? req.body.modules.filter(m => ['cats', 'levels', 'rules', 'tags', 'phases', 'resources'].includes(m))
      : ['cats', 'levels', 'rules', 'tags', 'phases', 'resources'];
    const share = { meta: Object.assign({}, data.meta || {}, { _share: true, shared: mods }) };
    if (mods.includes('cats')) share.cats = data.cats || [];
    if (mods.includes('levels')) share.levels = data.levels || [];
    if (mods.includes('rules')) share.rules = data.rules || [];
    if (mods.includes('tags')) share.tags = data.tags || [];
    if (mods.includes('phases')) share.phases = data.phases || [];
    if (mods.includes('resources')) share.resources = data.resources || [];
    const title = String(req.body.title || '').trim().slice(0, 60)
      || (data.phases && data.phases[0] && data.phases[0].name) || '我的规划';
    const id = crypto.randomBytes(6).toString('hex');
    await db.shareCreate(id, req.session.userId, title, JSON.stringify(share));
    res.json({ ok: true, id, url: (req.get('origin') || '') + '/#share=' + id });
  }));

  /* 读取分享（公开，任何人可访问；用于"打开链接一键套用"） */
  app.get('/api/share/:id', wrap(async (req, res) => {
    const row = await db.shareGet(String(req.params.id || ''));
    if (!row) return res.status(404).json({ error: '分享不存在或已失效' });
    let data = {};
    try { data = JSON.parse(row.data || '{}'); } catch (e) { data = {}; }
    res.json({ id: row.id, title: row.title, owner: row.owner, data });
  }));

  /* ---- 管理后台：业务数据看板 ---- */
  app.post('/api/admin/login', wrap(async (req, res) => {
    if (!ADMIN_TOKEN) return res.status(403).json({ error: '后台未启用（服务端未设置 ADMIN_TOKEN）' });
    if (authFail(req.ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' });
    const token = String(req.body.token || '').trim();
    if (token !== ADMIN_TOKEN) { authFail(req.ip); return res.status(401).json({ error: 'Token 错误' }); }
    authOk(req.ip);
    req.session.isAdmin = true;
    res.json({ ok: true });
  }));

  app.post('/api/admin/logout', requireAdmin, wrap(async (req, res) => {
    req.session.isAdmin = false;
    res.json({ ok: true });
  }));

  app.get('/api/admin/stats', requireAdmin, wrap(async (req, res) => {
    const store = await db.dbStats();
    const rows = await db.adminUsers();
    const users = [];
    const regDays = {};
    for (const r of rows) {
      let data = {};
      try { data = typeof r.data === 'string' ? JSON.parse(r.data || '{}') : (r.data || {}); } catch (e) { data = {}; }
      const day = new Date(r.created_at).toISOString().slice(0, 10);
      regDays[day] = (regDays[day] || 0) + 1;
      users.push({
        id: r.id,
        username: r.username,
        display_name: r.display_name || '', /* 🔴 修复：补齐字段——admin 表格需要显示名字，缺失则前端永远空白 */
        wechat: r.wechat || null,           /* 🔴 修复：补齐字段——admin 表格需要显示微信号 */
        created_at: r.created_at,
        updated_at: r.updated_at,
        is_dev: Number(r.is_dev) === 1 ? 1 : 0,
        email: r.email || null,
        rules: data.rules ? data.rules.length : 0,
        phases: data.phases ? data.phases.length : 0,
        cats: data.cats ? data.cats.length : 0,
        tags: data.tags ? data.tags.length : 0
      });
    }
    /* 失败模式分析（全站汇总）：逐用户计算后合并，
     * 算法与 /api/me/failure-analysis 共用 computeFailureAnalysis，避免逻辑分叉 */
    const merged = { totalCrashes: 0, totalRecovered: 0, byRule: {} };
    for (const r of rows) {
      const fa = computeFailureAnalysis(r.data);
      merged.totalCrashes += fa.totalCrashes;
      merged.totalRecovered += fa.totalRecovered;
      for (const t of fa.topCrashed) {
        if (!merged.byRule[t.rule]) merged.byRule[t.rule] = { rule: t.rule, count: 0, recovered: 0 };
        merged.byRule[t.rule].count += t.count;
        merged.byRule[t.rule].recovered += t.recovered;
      }
    }
    const topCrashed = Object.values(merged.byRule)
      .map(t => ({ ...t, rate: t.count ? Math.round(t.recovered / t.count * 100) : 0 }))
      .sort((a, b) => b.count - a.count).slice(0, 12);

    const now = Date.now();
    const inLast = (d, days) => (now - new Date(d).getTime()) <= days * 86400000;
    /* 近 7 天「活跃」：数据在 7 天内更新过的用户（updated_at 来自 profiles，未建档为 null） */
    const active7 = users.filter(u => u.updated_at && inLast(u.updated_at, 7)).length;
    /* 社区模板统计 */
    const allTpl = await db.templateListAll();
    const tplStats = {
      total: allTpl.length,
      pending: allTpl.filter(t => t.status === 'pending').length,
      approved: allTpl.filter(t => t.status === 'approved').length,
      rejected: allTpl.filter(t => t.status === 'rejected').length
    };
    res.json({
      totalUsers: users.length,
      last7: users.filter(u => inLast(u.created_at, 7)).length,
      last30: users.filter(u => inLast(u.created_at, 30)).length,
      active7,
      registrationsByDay: Object.keys(regDays).sort().map(d => ({ date: d, count: regDays[d] })),
      users,
      tplStats,
      /* 存储用量：当前占用 / 容量上限（env DATA_CAPACITY_MB，默认 500MB=Neon 免费档）/ 按平均还可容纳用户 */
      storage: {
        dbBytes: store.dbBytes,
        dataBytes: store.dataBytes,
        avgBytes: store.users ? Math.round(store.dataBytes / store.users) : 0,
        capacityBytes: (Number(process.env.DATA_CAPACITY_MB) || 500) * 1048576,
        remainUsers: store.avgBytes ? Math.max(0, Math.floor(((Number(process.env.DATA_CAPACITY_MB) || 500) * 1048576 - store.dataBytes) / store.avgBytes)) : null
      },
      failureAnalysis: {
        totalCrashes: merged.totalCrashes,
        totalRecovered: merged.totalRecovered,
        branchRate: merged.totalCrashes ? Math.round(merged.totalRecovered / merged.totalCrashes * 100) : 0,
        topCrashed
      },
      /* 系统运行状态（服务器监控） */
      sys: {
        uptimeSec: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        node: process.version,
        arch: process.platform + '/' + process.arch,
        pid: process.pid,
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        heapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
        dbEngine: db.USE_PG ? 'Postgres (Neon)' : 'SQLite',
        dbConnected: db.isConnected(),
        env: process.env.NODE_ENV || 'development'
      },
      /* 用量估算（云开发资源点）——按腾讯云官方计费标准（2026-08 版）：
       *   资源点单价：云托管 CPU 55点/核·小时、内存 32点/GB·小时；
       *   PostgreSQL CPU 342点/核·小时、容量 0.5点/GB·小时；
       *   小程序 API 调用 200点/万次、云开发 API 100点/万次、HTTP 30点/万次、云函数 13.3点/万次；
       *   估算 = 常驻成本（云托管 + PG 按配置规格 × 运行时长）+ 请求成本（API/DB 次数）。
       *   规格可经 env 校准：RESIDENT_CPU_CORE（默认 0.25 核）、RESIDENT_MEM_GB（默认 0.5GB）、
       *   PG_CPU_CORE（默认 0.25 核）、PG_PAUSED（默认 false：PG 自动暂停已开启则设 1）。 */
      usage: (function() {
        const now = Date.now();
        const dayStart = Math.floor(now / 86400000) * 86400000;
        const today = _buckets.filter(b => b.t >= dayStart);
        const last1h = _buckets.filter(b => b.t >= now - 3600000);
        const sum = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);
        const todayApi = sum(today, 'api'), todayRead = sum(today, 'dbRead'), todayWrite = sum(today, 'dbWrite');
        const h1Api = sum(last1h, 'api');
        /* ---- 常驻成本（官方单价） ---- */
        const CPU_RATE = 55, MEM_RATE = 32, PG_CPU_RATE = 342, PG_CAP_RATE = 0.5;
        const tcbCore = Number(process.env.RESIDENT_CPU_CORE) || 0.25;
        const tcbMem = Number(process.env.RESIDENT_MEM_GB) || 0.5;
        const pgCore = Number(process.env.PG_CPU_CORE) || 0.25;
        /* 方案3 后：profile 已搬云存储，PG 只跑 users 小表（登录/管理低频），CPU 趋近 0。
         * PG_PAUSED=1 或 CLOUD_STORAGE=1 都视为 PG 常驻成本归零。 */
        const pgPaused = process.env.PG_PAUSED === '1' || process.env.CLOUD_STORAGE === '1';
        const hoursToday = Math.max(1, Math.min(24, Math.ceil((now - dayStart) / 3600000)));
        const residentDay = tcbCore * CPU_RATE * 24 + tcbMem * MEM_RATE * 24
          + (pgPaused ? 0 : pgCore * PG_CPU_RATE * 24); /* PG 容量(0.5/GB·h × 0.1GB ≈ 1点/天)忽略 */
        /* ---- 请求成本（官方单价：API 调用 ≈ 100点/万次 → 每千次 10 点；DB 读写含在 API 内不计额外） ---- */
        const reqDay = todayApi / 10000 * 100; /* 简化：按 100点/万次 API */
        const todayPoints = residentDay * (hoursToday / 24) + reqDay;
        const projectedDayPoints = todayPoints / hoursToday * 24;
        return {
          today: { api: todayApi, dbRead: todayRead, dbWrite: todayWrite, estPoints: Math.round(todayPoints) },
          last1h: { api: h1Api, rpm: Math.round(h1Api / 60) },
          /* 常驻/请求 分项（官方单价，供面板展示） */
          breakdown: {
            residentDay: Math.round(residentDay),
            reqDay: Math.round(reqDay),
            tcbCpu: Math.round(tcbCore * CPU_RATE * 24),
            tcbMem: Math.round(tcbMem * MEM_RATE * 24),
            pgCpu: pgPaused ? 0 : Math.round(pgCore * PG_CPU_RATE * 24),
            pgPaused
          },
          projected: { dayPoints: Math.round(projectedDayPoints), monthPoints: Math.round(projectedDayPoints * 30) },
          buckets: _buckets.slice(-60).map(b => ({ t: b.t, api: b.api, dbR: b.dbRead, dbW: b.dbWrite }))
        };
      })(),
      generatedAt: new Date().toISOString()
    });
  }));

  /* ---- 模板市场：社区模板（需审核后公开） ---- */
  let builtinTplCache = null, builtinTplCacheAt = 0;
  function loadBuiltinTemplates() {
    const now = Date.now();
    /* 30s 内存缓存，减少每次磁盘读（模板文件变更后最多延迟 30s 生效，可接受） */
    if (builtinTplCache && now - builtinTplCacheAt < 30000) return builtinTplCache;
    let builtin = [];
    try {
      const fs = require('fs');
      const idxPath = path.join(__dirname, 'public', 'templates', 'index.json');
      if (fs.existsSync(idxPath)) builtin = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    } catch (e) { builtin = []; }
    builtinTplCache = builtin; builtinTplCacheAt = now;
    return builtin;
  }
  app.get('/api/templates', wrap(async (req, res) => {
    const builtin = loadBuiltinTemplates();
    const community = await db.templateListApproved();
    const uid = req.session.userId || null;
    const enriched = await Promise.all(community.map(async t => {
      const rating = await db.ratingStats(t.id);
      const favorited = uid ? await db.favoriteIs(t.id, uid) : false;
      return {
        id: t.id, title: t.title, author: t.author, desc: t.desc,
        tags: t.tags, counts: t.counts, file: 'community:' + t.id, source: 'community',
        rating, favorited
      };
    }));
    const list = [
      ...builtin.map(t => ({ ...t, source: 'builtin', rating: { avg: 0, count: 0 }, favorited: false })),
      ...enriched
    ];
    res.json(list);
  }));

  /* 登录用户可提交自己的规划作为社区模板（默认待审） */
  app.post('/api/templates', requireAuth, wrap(async (req, res) => {
    const b = req.body || {};
    const data = b.data;
    if (!data || !Array.isArray(data.rules) || !Array.isArray(data.cats) ||
        !Array.isArray(data.tags) || !Array.isArray(data.phases) || typeof data.daily !== 'object') {
      return res.status(400).json({ error: '模板数据不合法（缺 rules/cats/tags/phases/daily）' });
    }
    /* 模板体积上限：结构字段 JSON 超 300KB 拒绝（防超大模板成为公共下载负担） */
    try {
      const size = Buffer.byteLength(JSON.stringify({ rules: data.rules, cats: data.cats, levels: data.levels, tags: data.tags, phases: data.phases, resources: data.resources }));
      if (size > 300 * 1024) return res.status(400).json({ error: '模板过大（结构数据 >300KB），请精简后重试' });
    } catch (e) { return res.status(400).json({ error: '模板数据异常' }); }
    /* 安全：只保留结构字段，剥离个人运行数据（打卡/事件/复盘/随笔），避免模板泄露隐私。
     * 🔴 修复：retros（个人复盘随笔）属于隐私记录，绝不进社区模板 */
    const safe = {
      cats: data.cats, levels: data.levels || [], rules: data.rules,
      tags: data.tags, phases: data.phases, resources: data.resources || [],
      retros: [], daily: {},
      meta: Object.assign({}, data.meta || {}, { _tpl: true })
    };
    /* 安全：id 白名单校验（防注入内联事件构造存储型 XSS），非法 id 拒绝入库 */
    const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
    const bad = [];
    ['cats', 'levels', 'rules', 'tags', 'phases', 'resources', 'retros'].forEach(k => {
      (safe[k] || []).forEach(x => {
        if (x && x.id && !ID_RE.test(String(x.id))) bad.push(k + '.' + String(x.id).slice(0, 20));
      });
    });
    if (bad.length) return res.status(400).json({ error: '模板含非法 id（' + bad.slice(0, 3).join(', ') + '）' });
    const title = String(b.title || '').trim().slice(0, 60) || '未命名模板';
    /* author 强制取登录用户名，防冒用他人名义。
     * 🔴 修复：requireAuth 对小程序 JWT 只设 session.userId 不设 username → 之前恒为「匿名」；
     * 且审核通知按作者找用户，「匿名」找不到作者 → 作者收不到结果。改为按 userId 查真名。 */
    const me = await db.userById(req.session.userId);
    const author = (me && me.username) || (req.session.username || '匿名');
    const desc = String(b.desc || '').trim().slice(0, 300);
    const tags = Array.isArray(b.tags) ? b.tags.slice(0, 12).map(String).map(t => t.slice(0, 20)) : [];
    const counts = {
      rules: (safe.rules || []).length,
      phases: (safe.phases || []).length,
      resources: (safe.resources || []).length,
      retros: (safe.retros || []).length
    };
    const id = await db.templateAdd({ author, title, desc, tags, counts, data: safe });
    res.status(201).json({ ok: true, id, status: 'pending' });
  }));

  /* 个人数据占用（自己的 bag 大小 + 全站容量上限提示） */
  app.get('/api/me/stats', requireAuth, wrap(async (req, res) => {
    const row = await db.profileGet(req.session.userId);
    res.json({
      dataBytes: Buffer.byteLength(row || '{}', 'utf8'),
      capacityBytes: (Number(process.env.DATA_CAPACITY_MB) || 500) * 1048576
    });
  }));

  /* 导出全量数据（PIPL 数据可携带权）：GET /api/me/export → { profile, username, created_at } */
  app.get('/api/me/export', requireAuth, wrap(async (req, res) => {
    const raw = await db.profileGet(req.session.userId);
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
    const u = await db.userById(req.session.userId);
    res.json({
      exportedAt: new Date().toISOString(),
      username: req.session.username || (u && u.username) || '',
      created_at: u ? u.created_at : null,
      profile: data
    });
  }));

  /* 注销账号（PIPL 第 47 条 + 微信审核硬项）：删除全部数据，需二次确认字段 */
  app.delete('/api/me', requireAuth, wrap(async (req, res) => {
    const u = await db.userById(req.session.userId);
    if (!u) return res.status(404).json({ error: '账号不存在' });
    const confirmText = String(req.body.confirm || '');
    if (confirmText !== '删除') return res.status(400).json({ error: '请输入「删除」以确认注销' });
    await db.userDelete(u.id, u.username);
    req.session.destroy(() => {});
    res.json({ ok: true, msg: '账号已注销，数据已全部删除' });
  }));

  /* 已审核社区模板的数据（供套用/下载） */
  app.get('/api/templates/community/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的模板 ID' });
    const row = await db.templateGet(id);
    if (!row || row.status !== 'approved') return res.status(404).json({ error: '模板不存在或未审核' });
    let data = {};
    try { data = JSON.parse(row.data); } catch (e) { data = {}; }
    /* 兜底剥离个人运行数据（老模板可能带 daily/events/reviews），只返回结构字段 */
    const safe = {
      cats: data.cats || [], levels: data.levels || [], rules: data.rules || [],
      tags: data.tags || [], phases: data.phases || [], resources: data.resources || [],
      retros: data.retros || [], daily: {},
      meta: Object.assign({}, data.meta || {}, { _tpl: true })
    };
    res.json(safe);
  }));

  /* ---- 管理后台：社区模板审核 ---- */
  app.get('/api/admin/templates', requireAdmin, wrap(async (req, res) => {
    const rows = await db.templateListAll();
    res.json(rows.map(r => ({
      id: r.id, author: r.author, title: r.title, desc: r.desc,
      tags: r.tags || [], counts: r.counts || {}, status: r.status, created_at: r.created_at
    })));
  }));

  /* 管理后台：单个模板完整数据（审核预览用，仅管理员） */
  app.get('/api/admin/templates/:id', requireAdmin, wrap(async (req, res) => {
    const row = await db.templateGet(Number(req.params.id));
    if (!row) return res.status(404).json({ error: '模板不存在' });
    let data = {};
    try { data = JSON.parse(row.data); } catch (e) { data = {}; }
    res.json({
      id: row.id, author: row.author, title: row.title, desc: row.desc,
      tags: row.tags || [], counts: row.counts || {}, status: row.status, created_at: row.created_at, data
    });
  }));

  app.post('/api/admin/templates/:id/approve', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的模板 ID' });
    const row = await db.templateGet(id);
    await db.templateApprove(id);
    if (row && row.author) {
      const u = await db.userByName(row.author);
      if (u) await db.notify(u.id, 'template_approved', { template_id: id, title: row.title });
    }
    res.json({ ok: true });
  }));

  app.post('/api/admin/templates/:id/reject', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的模板 ID' });
    const row = await db.templateGet(id);
    await db.templateReject(id);
    if (row && row.author) {
      const u = await db.userByName(row.author);
      if (u) await db.notify(u.id, 'template_rejected', { template_id: id, title: row.title });
    }
    res.json({ ok: true });
  }));

  /* ---- 模板评分（登录用户 1-5 星） ---- */
  app.post('/api/templates/:id/rate', requireAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的模板 ID' });
    const tpl = await db.templateGet(id);
    if (!tpl || tpl.status !== 'approved') return res.status(404).json({ error: '模板不存在或未上架' });
    const score = Number(req.body && req.body.score);
    if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: '评分需在 1-5 之间' });
    await db.ratingUpsert(id, req.session.userId, score);
    res.json({ ok: true, rating: await db.ratingStats(id) });
  }));

  /* ---- 模板收藏（切换） ---- */
  app.post('/api/templates/:id/favorite', requireAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的模板 ID' });
    const tpl = await db.templateGet(id);
    if (!tpl || tpl.status !== 'approved') return res.status(404).json({ error: '模板不存在或未上架' });
    const favorited = await db.favoriteToggle(id, req.session.userId);
    res.json({ ok: true, favorited });
  }));

  /* ---- 站内通知（审核结果推送给作者） ---- */
  app.get('/api/notifications', requireAuth, wrap(async (req, res) => {
    const list = await db.notificationList(req.session.userId);
    const unread = await db.notificationUnreadCount(req.session.userId);
    res.json({ list, unread });
  }));
  app.post('/api/notifications/read', requireAuth, wrap(async (req, res) => {
    await db.notificationMarkRead(req.session.userId);
    res.json({ ok: true });
  }));

  /* 首页 / 管理页：直接读取 HTML 返回（CSP 已不再使用 nonce，无需注入） */
  function serveHtml(file) {
    return (req, res) => {
      try {
        const fs = require('fs');
        const html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
        res.type('html').send(html);
      } catch (e) { res.status(500).send('load error'); }
    };
  }
  app.get('/', serveHtml('index.html'));
  app.get('/admin.html', serveHtml('admin.html'));

  /* 静态前端（除首页/管理页外的资源：css/js/templates 等） */
  app.use(express.static(path.join(__dirname, 'public')));

  app.listen(PORT, () => {
    console.log(`✅ 底层创造者OS 多用户版运行中： http://localhost:${PORT}`);
  });

  /* ============ 用量计数器（资源点估算用） ============
   * 内存级轻量采样：每分钟一个桶，记录该分钟的 API 请求数 + DB 读/写次数
   * 供 admin /api/admin/stats 输出当日/最近 60 分钟曲线 + 月底估算 */
  const _buckets = []; /* [{ t: 分钟时间戳, api, dbRead, dbWrite }]，最多保留 1440 个（24h） */
  let _curBucket = null;
  function tickUsage() {
    const minute = Math.floor(Date.now() / 60000) * 60000;
    if (!_curBucket || _curBucket.t !== minute) {
      _curBucket = { t: minute, api: 0, dbRead: 0, dbWrite: 0 };
      _buckets.push(_curBucket);
      if (_buckets.length > 1440) _buckets.shift();
    }
    return _curBucket;
  }
  globalThis.__incUsageApi = () => { tickUsage().api++; };
  globalThis.__incUsageDbRead = () => { tickUsage().dbRead++; };
  globalThis.__incUsageDbWrite = () => { tickUsage().dbWrite++; };
  /* 自启动后预热：立即生成一个桶（避免 stats 接口访问时 _curBucket=null） */
  tickUsage();

  /* 后台异步连接数据库：失败不退出，5s 后重试，直到 Neon 唤醒。 */
  connectDBLoop();
  /* 每日自动备份（写入 backups 表，admin 可下载） */
  scheduleAutoBackup();
  /* 订阅消息定时提醒（未配置模板 ID 时仅日志提示） */
  scheduleReminders();
}

function connectDBLoop() {
  db.init()
    .then(() => console.log('✅ 数据库已就绪（后台连接成功）'))
    .catch((e) => {
      console.warn('⚠️ 数据库暂未就绪，5s 后后台重试：', (e && e.message) || e);
      setTimeout(connectDBLoop, 5000);
    });
}

/* 启动兜底：任何未捕获的异常 / Promise 拒绝都打印清楚日志，
 * 避免「Exited with status 1」却看不到真正原因（Render 部署失败难排查）。 */
process.on('unhandledRejection', (reason) => {
  console.error('❌ 未捕获的 Promise 拒绝：', reason);
});
process.on('uncaughtException', (err) => {
  /* Render 免费层下，偶发的异常不应直接杀死进程导致部署 status 1；
   * 仅记录日志，保留服务存活。 */
  console.error('❌ 未捕获异常（已记录，进程继续运行）：', err);
});
start().catch((err) => {
  console.error('❌ 应用启动失败：', err);
  process.exit(1);
});
