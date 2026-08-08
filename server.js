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
/* 安全：生产环境禁止使用默认 SESSION_SECRET（可被伪造 session cookie 提权） */
if (process.env.NODE_ENV === 'production' && SESSION_SECRET === 'rootos-dev-secret-change-me') {
  console.error('🚨 严重安全警告：生产环境使用默认 SESSION_SECRET！请立即在环境变量设置随机 SESSION_SECRET 并重新部署。');
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
function issueCode(email) {
  const code = String(crypto.randomInt(100000, 1000000));
  emailCodes.set(email, { code, exp: Date.now() + 10 * 60 * 1000 });
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
  if (String(code || '').trim() !== v.code) return false;
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

function defaultBag() {
  return {
    cats: [
      { id: 'c_study',  name: '学习', color: '#4fc1ff' },
      { id: 'c_focus',  name: '专注', color: '#4ec9b0' },
      { id: 'c_play',   name: '娱乐', color: '#dcdcaa' },
      { id: 'c_health', name: '健康', color: '#f44747' },
      { id: 'c_life',   name: '生活', color: '#c586c0' }
    ],
    levels: [
      { id: 'lv0', name: '根部' },
      { id: 'lv1', name: '中层' },
      { id: 'lv2', name: '顶层' }
    ],
    /* parent=null 为主链节点；parent=某规则 id 为该节点的支链（主链崩溃时才激活） */
    rules: [
      /* 学习 */
      { id: 'r_stu1', cat: 'c_study', lv: 'lv0', t: '主线课程/主线任务推进 1 节', on: true, parent: null, seq: 1 },
      { id: 'r_stu2', cat: 'c_study', lv: 'lv0', t: '背单词 / 记术语 30min', on: true, parent: null, seq: 2 },
      { id: 'r_stu3', cat: 'c_study', lv: 'lv1', t: '动手练习：写代码 / 做题 / 实操 30min', on: true, parent: null, seq: 1, micro: '先只写 5 行代码 / 做 1 题，侦测手感再决定继续' },
      { id: 'r_stu4', cat: 'c_study', lv: 'lv1', t: '啃一块硬骨头（当前最难的知识点）', on: true, parent: null, seq: 2 },
      { id: 'r_stu5', cat: 'c_study', lv: 'lv2', t: '当日产出留痕（提交 / 笔记 / 截图）', on: true, parent: null, seq: 1 },
      { id: 'r_stu6', cat: 'c_study', lv: 'lv2', t: '每周 10min 三问复盘', on: true, parent: null, seq: 2 },
      /* 专注 */
      { id: 'r_foc1', cat: 'c_focus', lv: 'lv0', t: '开工前先到固定工位坐下（仪式感启动）', on: true, parent: null, seq: 1 },
      { id: 'r_foc2', cat: 'c_focus', lv: 'lv0', t: '两分钟规则：只承诺做 2 分钟', on: true, parent: null, seq: 2, micro: '先只做 2 分钟，时间到再决定续不续' },
      { id: 'r_foc3', cat: 'c_focus', lv: 'lv1', t: '45min 深专注块 ×2', on: true, parent: null, seq: 1 },
      { id: 'r_foc4', cat: 'c_focus', lv: 'lv2', t: '到外部场所（图书馆/自习室/咖啡馆）≥2h', on: true, parent: null, seq: 1 },
      /* 娱乐 */
      { id: 'r_pla1', cat: 'c_play', lv: 'lv0', t: '娱乐片段结束即停，不续播', on: true, parent: null, seq: 1 },
      { id: 'r_pla2', cat: 'c_play', lv: 'lv1', t: '开始娱乐前先设定时器（到点即停）', on: true, parent: null, seq: 1 },
      { id: 'r_pla3', cat: 'c_play', lv: 'lv2', t: '零无意识刷屏日（拿手机前先想：要看什么）', on: true, parent: null, seq: 1 },
      /* 健康（睡眠卫生 + 冲动管理，承接原戒断链） */
      { id: 'r_hlt1', cat: 'c_health', lv: 'lv0', t: '睡前 1 小时放下手机（闹钟放远处）', on: true, parent: null, seq: 1 },
      { id: 'r_hlt2', cat: 'c_health', lv: 'lv1', t: '冲动来袭 → 先做 15 分钟别的事', on: true, parent: null, seq: 1 },
      { id: 'r_hlt3', cat: 'c_health', lv: 'lv2', t: '连续 7 天守住关键底线（链式记录）', on: true, parent: null, seq: 1 },
      { id: 'r_hlt4', cat: 'c_health', lv: 'lv1', t: '小睡 ≤20min 且不晚于 15 点', on: true, parent: null, seq: 2 },
      { id: 'r_hlt5', cat: 'c_health', lv: 'lv2', t: '全天保持清醒节奏（白天不补觉）', on: true, parent: null, seq: 2 },
      /* 生活 · 晨间主链 */
      { id: 'r_lif1',  cat: 'c_life', lv: 'lv0', t: '起床脚落地，不沾床', on: true, parent: null, seq: 1 },
      { id: 'r_lif2a', cat: 'c_life', lv: 'lv0', t: '刷牙洗脸', on: true, parent: null, seq: 2 },
      { id: 'r_lif2',  cat: 'c_life', lv: 'lv0', t: '开窗见光，唤醒身体', on: true, parent: null, seq: 3 },
      { id: 'r_lif2b', cat: 'c_life', lv: 'lv0', t: '吃一份带蛋白质的早餐', on: true, parent: null, seq: 4 },
      { id: 'r_lif7',  cat: 'c_life', lv: 'lv0', t: '走出家门 → 去到学习/工作场所', on: true, parent: null, seq: 5 },
      { id: 'r_lif3',  cat: 'c_life', lv: 'lv0', t: '清醒时段不吃零食/不喝含糖饮料', on: true, parent: null, seq: 6 },
      /* 早起失败支链（挂在 r_lif1 下） */
      { id: 'r_lif1b1', cat: 'c_life', lv: 'lv0', t: '补觉 ≤20min（沙发，不躺回床）', on: true, parent: 'r_lif1', seq: 1 },
      { id: 'r_lif1b2', cat: 'c_life', lv: 'lv0', t: '洗漱后直接开始当日第一件事', on: true, parent: 'r_lif1', seq: 2 },
      /* 生活中层 */
      { id: 'r_lif5', cat: 'c_life', lv: 'lv1', t: '固定时间上床（睡足 7-8 小时）', on: true, parent: null, seq: 1 }
    ],
    tags: [
      { id: 't_social', name: '社交日',     color: '#e8912d', degrade: true },
      { id: 't_lib',    name: '外出学习日', color: '#4ec9b0', degrade: false },
      { id: 't_chaos',  name: '高扰动',     color: '#f44747', degrade: true },
      { id: 't_sleepy', name: '低能量日',   color: '#569cd6', degrade: true }
    ],
    daily: {},
    events: [],
    phases: [
      { id: 'p1', parent: null, name: '第一阶段 · 系统冷启动', start: dayOff(0), end: dayOff(30), imp: 3, done: false, journal: '',
        goal: '把早起主链连续跑通 21 天 + 锁定 1 条主线任务 + 建立每日留痕习惯' },
      { id: 'p1a', parent: 'p1', name: '7 天启动清单', start: dayOff(0), end: dayOff(6), imp: 3, done: false, journal: '',
        goal: 'Day1 砍到只留 3 条根部规则 / Day2 布置固定工位 / Day3 跑通一次 45min 专注块 / Day5 建立产出留痕的地方 / Day7 做第一次周复盘' },
      { id: 'p2', parent: null, name: '第二阶段 · 主链加固', start: dayOff(31), end: dayOff(120), imp: 3, done: false, journal: '',
        goal: '根部完成率 ≥80% + 主线任务推进过半 + 关键底线连续 7 天守住' },
      { id: 'p3', parent: null, name: '第三阶段 · 顶层输出', start: dayOff(121), end: dayOff(240), imp: 2, done: false, journal: '',
        goal: '把学到的东西做成一个能拿出手的作品，完成「输入 → 输出」闭环' }
    ],
    reviews: { day: {}, week: {}, month: {} },
    /* 通用复盘随笔（不绑定日/周/月结构，随手记）与「规划·资源」收藏 */
    retros: [],
    resources: [],
    meta: { version: 'webapp-1.0' }
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
/* 自动备份：每天把全库数据快照上传到 CloudBase 云存储 backups/，保留最近 7 份。
 * 云托管自动注入 TCB_ENV（同环境云资源免密钥访问）；本地/未配置时静默跳过。 */
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
        created_at: r.created_at, updated_at: r.updated_at, data: (() => { try { return JSON.parse(r.data || '{}'); } catch (e) { return {}; } })()
      }))
    };
    const cloudbase = require('@cloudbase/node-sdk');
    const app = cloudbase.init({ env: process.env.TCB_ENV });
    const storage = app.storage();
    const date = new Date().toISOString().slice(0, 10);
    await storage.uploadFile({
      cloudPath: 'backups/rootos-' + date + '.json',
      fileContent: Buffer.from(JSON.stringify(snapshot, null, 1))
    });
    /* 清理：保留最近 7 份备份 */
    try {
      const list = await storage.getFileList({ prefix: 'backups/', limit: 100 });
      const files = (list.FileList || []).filter(f => /^backups\/rootos-\d{4}-\d{2}-\d{2}\.json$/.test(f.Key));
      files.sort((a, b) => b.Key.localeCompare(a.Key));
      for (const f of files.slice(7)) {
        await storage.deleteFile({ fileList: [f.Key] });
      }
    } catch (e) { /* 清理失败不影响本次备份 */ }
    console.log('✅ 自动备份完成：', date);
  } catch (e) {
    console.warn('⚠️ 自动备份跳过（云存储未配置/不可用）：', (e && e.message) || e);
  }
}
function scheduleAutoBackup() {
  runAutoBackup();
  /* 每天 0 点执行（用服务器时区近似） */
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
/* 定时下发：每天 20:00 打卡提醒；周日 20:00 复盘提醒 */
async function sendReminders() {
  const tplRemind = process.env.WX_SUB_TMPL_REMIND;
  const tplWeekly = process.env.WX_SUB_TMPL_WEEKLY;
  if (!tplRemind && !tplWeekly) {
    console.warn('⏰ 订阅消息未启用：请配置环境变量 WX_SUB_TMPL_REMIND（打卡提醒模板 ID），可选 WX_SUB_TMPL_WEEKLY（周复盘模板 ID）');
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
    if (now.getHours() === 20 && now.getMinutes() < 30) {
      const key = now.toISOString().slice(0, 10) + (now.getDay() === 0 ? '-wk' : '-day');
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

  app.use(express.json({ limit: '5mb' }));
  /* 会话持久化：配置了 DATABASE_URL（Neon）时把 session 存数据库——
   * 云托管实例重启/闲置回收后网页登录态不丢（不用每次刷新重新登录）。
   * 本地 SQLite 开发模式仍用内存 store。 */
  const sessConf = {
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 24 * 3600 * 1000 }
  };
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const PgSession = require('connect-pg-simple')(session);
    sessConf.store = new PgSession({
      pool: new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 }),
      tableName: 'session',
      createTableIfMissing: true
    });
  }
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
      if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
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
    if (req.session.userId) return next();
    const uid = wxUidFromReq(req);
    if (!uid) return res.status(401).json({ error: '未登录' });
    req.session.userId = uid;
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
    if (username.length < 2) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(400).json({ error: '用户名至少 2 个字符' }); }
    if (password.length < 6) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(400).json({ error: '密码至少 6 位' }); }
    const exists = await db.userByName(username);
    if (exists) { if (authFail(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' }); return res.status(409).json({ error: '用户名已被占用' }); }
    const pw_hash = bcrypt.hashSync(password, 10);
    const uid = await db.createUser(username, pw_hash);
    /* 注册名若为邮箱格式（老用户习惯把邮箱当用户名），自动写入 email 字段（未验证），
     * 这样不绑定也能用该邮箱走「找回密码」流程 */
    if (EMAIL_RE.test(username)) await db.userBindEmail(uid, username.toLowerCase());
    await db.profileSet(uid, JSON.stringify(defaultBag()));
    req.session.userId = uid;
    req.session.username = username;
    authOk(ip);
    res.json({ ok: true, username });
  }));

  /* 登录：先校验密码，正确即放行并清零失败计数（不误伤终于输对的人）；
     只有密码错误时才累加限流，连续失败超阈值才返回 429。 */
  app.post('/api/login', wrap(async (req, res) => {
    const ip = req.ip;
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const u = await db.userByName(username);
    if (u && bcrypt.compareSync(password, u.pw_hash)) {
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
    res.json({
      username: u ? u.username : req.session.username,
      email: u ? (u.email || '') : '',
      email_verified: u ? !!u.email_verified : false,
      wechat: u ? (u.wechat || '') : ''
    });
  }));

  /* ---- 用户系统 v1.2：邮箱绑定 / 找回密码 / 微信绑定 / 改密 ---- */

  /* ① 发送邮箱绑定验证码（登录态） */
  app.post('/api/email/send-code', requireAuth, wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    const holder = await db.userFindByEmail(email);
    if (holder && holder.id !== req.session.userId) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
    if (!smtpReady()) return res.status(503).json({ error: '服务端未配置 SMTP，无法发送验证码（可联系管理员配置 SMTP_HOST/USER/PASS）' });
    const code = issueCode(email);
    const r = await sendCodeMail(email, code, 'bind');
    if (r.err) return res.status(500).json({ error: '验证码发送失败，请稍后再试' });
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

  /* ④ 重置密码（邮箱 + 验证码） */
  app.post('/api/forgot/reset', wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    if (!checkCode(email, code)) return res.status(400).json({ error: '验证码错误或已过期' });
    if (password.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const holder = await db.userFindByEmail(email);
    if (!holder) return res.status(404).json({ error: '该邮箱未绑定任何账号' });
    await db.userSetPassword(holder.id, bcrypt.hashSync(password, 10));
    res.json({ ok: true, msg: '密码已重置，请用新密码登录' });
  }));

  /* ⑤ 绑定微信号（字符串形式；小程序 openid 绑定走另一接口，见下） */
  app.post('/api/wechat/bind', requireAuth, wrap(async (req, res) => {
    const wechat = String(req.body.wechat || '').trim();
    if (!wechat) return res.status(400).json({ error: '微信号不能为空' });
    if (wechat.length > 64) return res.status(400).json({ error: '微信号过长' });
    await db.userSetWechat(req.session.userId, wechat);
    res.json({ ok: true, wechat });
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
    if (u) return res.json({ ok: true, token: issueWxToken(u.id), username: u.username, bound: true });
    /* 未绑定：自动注册一个新账号（微信一键登录直达，无需先有网页账号）。
     * 用户名取 wx_ + openid 片段（冲突时加序号）；密码随机不可知——用户之后可在设置页设密码，
     * 或通过「绑定网页账号」把 openid 关联到已有网页账号。 */
    let uname = 'wx_' + openid.slice(0, 10);
    let seq = 2;
    while (await db.userByName(uname)) uname = 'wx_' + openid.slice(0, 10) + '_' + (seq++);
    const randPw = crypto.randomBytes(16).toString('hex');
    const uid = await db.createUser(uname, bcrypt.hashSync(randPw, 10));
    await db.userBindOpenid(uid, openid);
    await db.profileSet(uid, JSON.stringify(defaultBag()));
    console.log('✅ 微信自动注册新账号：', uname);
    res.json({ ok: true, token: issueWxToken(uid), username: uname, bound: true, auto_registered: true });
  }));

  /* ⑥b 小程序绑定 web 账号：openid + 网页账号密码 → 关联并签发 token（IP 限流防爆破） */
  app.post('/api/wechat/bind-openid', wrap(async (req, res) => {
    const ip = req.ip;
    const openid = String(req.body.openid || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!openid) return res.status(400).json({ error: '缺少 openid' });
    const u = await db.userByName(username);
    if (!u || !bcrypt.compareSync(password, u.pw_hash)) {
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
      const hData = parse(await db.profileGet(holder.id));
      const tData = parse(await db.profileGet(u.id));
      ['cats', 'levels', 'rules', 'tags', 'phases', 'reviews', 'retros', 'resources'].forEach(k => {
        const v = tData[k];
        if (!v || (Array.isArray(v) && !v.length)) tData[k] = hData[k];
      });
      tData.daily = Object.assign({}, hData.daily || {}, tData.daily || {});
      tData.events = [...(hData.events || []), ...(tData.events || [])];
      await db.profileSet(u.id, JSON.stringify(tData));
      await db.userBindOpenid(holder.id, null);
    }
    await db.userBindOpenid(u.id, openid);
    res.json({ ok: true, token: issueWxToken(u.id), username: u.username, bound: true });
  }));

  /* ⑥c 保存订阅消息状态（小程序点击"开启每日提醒"后） */
  app.post('/api/wechat/subscribe', requireAuth, wrap(async (req, res) => {
    const tplId = String(req.body.tplId || '').trim();
    const enabled = req.body.enabled !== false;
    await db.subUpsert(req.session.userId, tplId, enabled);
    res.json({ ok: true, enabled });
  }));

  /* ⑦ 修改密码（需旧密码） */
  app.post('/api/password/change', requireAuth, wrap(async (req, res) => {
    const oldPw = String(req.body.old || '');
    const nextPw = String(req.body.next || '');
    const u = await db.userById(req.session.userId);
    if (!u || !bcrypt.compareSync(oldPw, u.pw_hash)) return res.status(400).json({ error: '当前密码不正确' });
    if (nextPw.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    await db.userSetPassword(u.id, bcrypt.hashSync(nextPw, 10));
    res.json({ ok: true, msg: '密码已更新' });
  }));

  /* ⑧ 绑定已有网页账号（v1.4：微信自动注册账号 → 并入已有网页账号，数据合并）
   * 场景：用户先用微信登录生成了 wx_ 账号，想把数据并到原来的网页账号（如邮箱注册的），
   * 之后微信登录直接进网页账号。 */
  app.post('/api/account/merge-web', requireAuth, wrap(async (req, res) => {
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');
    const target = await db.userByName(username);
    if (!target || !bcrypt.compareSync(password, target.pw_hash)) return res.status(401).json({ error: '账号或密码错误' });
    if (target.id === req.session.userId) return res.status(400).json({ error: '当前已是该账号，无需绑定' });
    const cur = await db.userById(req.session.userId);
    if (!cur || !cur.wx_openid) return res.status(400).json({ error: '当前账号没有微信绑定，无法合并' });
    /* 只禁止：openid 已被【其他账号】绑定。当前账号自己持有 openid 是正常情况（就是要转给目标账号） */
    const holder = await db.userFindByOpenid(cur.wx_openid);
    if (holder && holder.id !== req.session.userId && holder.id !== target.id) return res.status(409).json({ error: '该微信已绑定其他账号' });
    /* 数据合并：目标账号为主，当前微信账号补缺失结构 + 合并 daily/events */
    const parse = s => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };
    const curData = parse(await db.profileGet(req.session.userId));
    const tgtData = parse(await db.profileGet(target.id));
    ['cats', 'levels', 'rules', 'tags', 'phases', 'reviews', 'retros', 'resources'].forEach(k => {
      const v = tgtData[k];
      if (!v || (Array.isArray(v) && !v.length)) tgtData[k] = curData[k];
    });
    tgtData.daily = Object.assign({}, curData.daily || {}, tgtData.daily || {});
    tgtData.events = [...(curData.events || []), ...(tgtData.events || [])];
    await db.profileSet(target.id, JSON.stringify(tgtData));
    /* openid 转给目标账号；当前 wx_ 账号解除（下次微信登录直接进目标账号） */
    await db.userBindOpenid(target.id, cur.wx_openid);
    await db.userBindOpenid(req.session.userId, null);
    console.log('✅ 账号合并：', cur.username, '→', target.username);
    res.json({ ok: true, token: issueWxToken(target.id), username: target.username, msg: '已绑定并合并数据' });
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
  app.get('/api/data', requireAuth, wrap(async (req, res) => {
    const raw = await db.profileGet(req.session.userId);
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
    if (!data || Object.keys(data).length === 0) {
      data = defaultBag();
      await db.profileSet(req.session.userId, JSON.stringify(data));
    }
    /* 多端同步：以服务器时钟为准，返回数据最后更新时间（供前端判断本地是否较新），
     * 避免依赖客户端时钟（设备时钟不一致会导致数据被静默覆盖） */
    const updatedAt = await db.profileUpdatedAt(req.session.userId);
    if (updatedAt) res.setHeader('X-Data-Updated', updatedAt);
    res.json(data);
  }));

  /* 保存数据（整包覆盖） */
  app.put('/api/data', requireAuth, wrap(async (req, res) => {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: '数据格式错误' });
    const clean = { ...defaultBag(), ...req.body };
    /* 绝不接受任何令牌类字段（本项目无 GitHub 同步，留作安全护栏） */
    if (clean.meta) delete clean.meta.ghToken;
    await db.profileSet(req.session.userId, JSON.stringify(clean));
    res.json({ ok: true });
  }));

  /* ---- 分享快照（v0.6：把规划生成链接，别人打开一键套用） ---- */

  /* 创建分享：把当前用户的规划结构（不含打卡/事件）存为公开只读快照，返回短链接 */
  app.post('/api/share/create', requireAuth, wrap(async (req, res) => {
    const raw = await db.profileGet(req.session.userId);
    let data = {};
    try { data = JSON.parse(raw || '{}'); } catch (e) { data = {}; }
    if (!Array.isArray(data.rules) || !data.rules.length) return res.status(400).json({ error: '当前没有可分享的规划' });
    /* 只分享结构字段，不含运行数据（daily/events）与隐私内容（reviews 复盘/retros 随笔）；
     * resources 规划资源作为规划的一部分保留 */
    const share = {
      cats: data.cats || [], levels: data.levels || [], rules: data.rules,
      tags: data.tags || [], phases: data.phases || [],
      resources: data.resources || [],
      meta: Object.assign({}, data.meta || {}, { _share: true })
    };
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
    const token = String(req.body.token || '').trim();
    if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Token 错误' });
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
        created_at: r.created_at,
        updated_at: r.updated_at,
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
      generatedAt: new Date().toISOString()
    });
  }));

  /* ---- 模板市场：社区模板（需审核后公开） ---- */
  app.get('/api/templates', wrap(async (req, res) => {
    let builtin = [];
    try {
      const fs = require('fs');
      const idxPath = path.join(__dirname, 'public', 'templates', 'index.json');
      if (fs.existsSync(idxPath)) builtin = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    } catch (e) { builtin = []; }
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
    const title = String(b.title || '').trim() || '未命名模板';
    const author = String(b.author || '').trim() || (req.session.username || '匿名');
    const desc = String(b.desc || '').trim();
    const tags = Array.isArray(b.tags) ? b.tags.slice(0, 12).map(String) : [];
    const counts = {
      rules: (data.rules || []).length,
      phases: (data.phases || []).length,
      resources: (data.resources || []).length,
      retros: (data.retros || []).length
    };
    const id = await db.templateAdd({ author, title, desc, tags, counts, data });
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

  /* 已审核社区模板的数据（供套用/下载） */
  app.get('/api/templates/community/:id', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的模板 ID' });
    const row = await db.templateGet(id);
    if (!row || row.status !== 'approved') return res.status(404).json({ error: '模板不存在或未审核' });
    let data = {};
    try { data = JSON.parse(row.data); } catch (e) { data = {}; }
    res.json(data);
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
    const score = Number(req.body && req.body.score);
    if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: '评分需在 1-5 之间' });
    await db.ratingUpsert(id, req.session.userId, score);
    res.json({ ok: true, rating: await db.ratingStats(id) });
  }));

  /* ---- 模板收藏（切换） ---- */
  app.post('/api/templates/:id/favorite', requireAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的模板 ID' });
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

  /* 后台异步连接数据库：失败不退出，5s 后重试，直到 Neon 唤醒。 */
  connectDBLoop();
  /* 每日自动备份（DB 就绪后执行；云存储不可用时静默跳过） */
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
