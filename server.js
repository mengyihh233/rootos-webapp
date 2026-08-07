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

/* ---------- 新用户默认数据包 ----------
 * 通用启动模板（已剔除医学 / 成人内容模块，完整保留坏习惯戒断链）。
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
      { id: 'c_study', name: '学习', color: '#4fc1ff' },
      { id: 'c_focus', name: '专注', color: '#4ec9b0' },
      { id: 'c_play',  name: '娱乐', color: '#dcdcaa' },
      { id: 'c_quit',  name: '戒断', color: '#f44747' },
      { id: 'c_life',  name: '生活', color: '#c586c0' }
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
      { id: 'r_stu3', cat: 'c_study', lv: 'lv1', t: '动手练习：写代码 / 做题 / 实操 30min', on: true, parent: null, seq: 1 },
      { id: 'r_stu4', cat: 'c_study', lv: 'lv1', t: '啃一块硬骨头（当前最难的知识点）', on: true, parent: null, seq: 2 },
      { id: 'r_stu5', cat: 'c_study', lv: 'lv2', t: '当日产出留痕（提交 / 笔记 / 截图）', on: true, parent: null, seq: 1 },
      { id: 'r_stu6', cat: 'c_study', lv: 'lv2', t: '每周 10min 三问复盘', on: true, parent: null, seq: 2 },
      /* 专注 */
      { id: 'r_foc1', cat: 'c_focus', lv: 'lv0', t: '想干活先坐「神圣座位」（固定工位）', on: true, parent: null, seq: 1 },
      { id: 'r_foc2', cat: 'c_focus', lv: 'lv0', t: '两分钟规则：只承诺做 2 分钟', on: true, parent: null, seq: 2 },
      { id: 'r_foc3', cat: 'c_focus', lv: 'lv1', t: '45min 深专注块 ×2', on: true, parent: null, seq: 1 },
      { id: 'r_foc4', cat: 'c_focus', lv: 'lv2', t: '到外部场所（图书馆/自习室/咖啡馆）≥2h', on: true, parent: null, seq: 1 },
      /* 娱乐 */
      { id: 'r_pla1', cat: 'c_play', lv: 'lv0', t: '视频看完一节就关网页', on: true, parent: null, seq: 1 },
      { id: 'r_pla2', cat: 'c_play', lv: 'lv1', t: '娱乐只开熔断模式（先点 25min 计时）', on: true, parent: null, seq: 1 },
      { id: 'r_pla3', cat: 'c_play', lv: 'lv2', t: '零无意识刷屏日', on: true, parent: null, seq: 1 },
      /* 戒断（坏习惯戒断链） */
      { id: 'r_qui1', cat: 'c_quit', lv: 'lv0', t: '22:30 手机放到卧室外充电', on: true, parent: null, seq: 1 },
      { id: 'r_qui2', cat: 'c_quit', lv: 'lv1', t: '冲动触发 → 立刻 15 分钟冷却', on: true, parent: null, seq: 1 },
      { id: 'r_qui3', cat: 'c_quit', lv: 'lv2', t: '连续 7 天无破戒（链式记录）', on: true, parent: null, seq: 1 },
      /* 生活 · 晨间主链 */
      { id: 'r_lif1',  cat: 'c_life', lv: 'lv0', t: '起床脚落地，不沾床', on: true, parent: null, seq: 1 },
      { id: 'r_lif2a', cat: 'c_life', lv: 'lv0', t: '刷牙洗脸（冷水开机）', on: true, parent: null, seq: 2 },
      { id: 'r_lif2',  cat: 'c_life', lv: 'lv0', t: '开灯开窗帘（光照开机）', on: true, parent: null, seq: 3 },
      { id: 'r_lif2b', cat: 'c_life', lv: 'lv0', t: '吃一份带蛋白质的早餐', on: true, parent: null, seq: 4 },
      { id: 'r_lif7',  cat: 'c_life', lv: 'lv0', t: '走出家门 → 去到学习/工作场所', on: true, parent: null, seq: 5 },
      { id: 'r_lif3',  cat: 'c_life', lv: 'lv0', t: '清醒时段不吃零食/不喝含糖饮料', on: true, parent: null, seq: 6 },
      /* 早起失败支链（挂在 r_lif1 下） */
      { id: 'r_lif1b1', cat: 'c_life', lv: 'lv0', t: '补觉 ≤20min（沙发，不躺回床）', on: true, parent: 'r_lif1', seq: 1 },
      { id: 'r_lif1b2', cat: 'c_life', lv: 'lv0', t: '洗漱+光照后直接出门', on: true, parent: 'r_lif1', seq: 2 },
      /* 生活中层/顶层 */
      { id: 'r_lif4', cat: 'c_life', lv: 'lv1', t: '小睡 ≤20min 且不晚于 15 点', on: true, parent: null, seq: 1 },
      { id: 'r_lif5', cat: 'c_life', lv: 'lv1', t: '23:30 前上床', on: true, parent: null, seq: 2 },
      { id: 'r_lif6', cat: 'c_life', lv: 'lv2', t: '全天清醒无补觉', on: true, parent: null, seq: 1 }
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
        goal: '把晨间主链连续跑通 21 天 + 锁定 1 条主线任务 + 建立每日留痕习惯' },
      { id: 'p1a', parent: 'p1', name: '7 天启动清单', start: dayOff(0), end: dayOff(6), imp: 3, done: false, journal: '',
        goal: 'Day1 砍到只留 3 条根部规则 / Day2 布置神圣座位 / Day3 跑通一次 45min 专注块 / Day5 建立产出留痕的地方 / Day7 做第一次周复盘' },
      { id: 'p2', parent: null, name: '第二阶段 · 主链加固', start: dayOff(31), end: dayOff(120), imp: 3, done: false, journal: '',
        goal: '根部完成率 ≥80% + 主线任务推进过半 + 戒断门类连续 7 天无破戒' },
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
async function start() {
  await db.init();

  const app = express();
  /* 部署在 Nginx / Caddy / Render 反代之后时必须开启，
   * 否则 NODE_ENV=production 下 cookie 的 secure 标志会导致登录态无法建立 */
  app.set('trust proxy', 1);

  /* 安全响应头：纵深防御 XSS / MIME 嗅探 / Referrer 泄露。
   * 每请求生成一次性 nonce，注入到 <script>/<style> 标签（script-src/style-src 同时声明 nonce 作为纵深）；
   * 因全站使用 inline event handler（onclick="..."），script-src 仍需保留 'unsafe-inline'
   * —— 要彻底移除需把事件绑定改为 addEventListener（重构级，列为后续可选）。
   * 收紧 object-src='none'（禁用插件/嵌套浏览上下文）、base-uri/form-action 已限 'self'。
   * 注意：frame-ancestors 故意不限制，以免破坏 WorkBuddy 预览的跨域 iframe（沿用既有决策）。 */
  app.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    req.nonce = nonce;
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'nonce-" + nonce + "'; " +
      "style-src 'self' 'unsafe-inline' 'nonce-" + nonce + "'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
      "base-uri 'self'; form-action 'self'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(express.json({ limit: '5mb' }));
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
  }));

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
    return b.n > 20;
  }
  function authOk(ip) { authFails.delete(ip); }

  function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
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

  /* 当前用户 */
  app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    res.json({ username: req.session.username });
  });

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
    res.json({
      totalUsers: users.length,
      last7: users.filter(u => inLast(u.created_at, 7)).length,
      last30: users.filter(u => inLast(u.created_at, 30)).length,
      registrationsByDay: Object.keys(regDays).sort().map(d => ({ date: d, count: regDays[d] })),
      users,
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

  /* 已审核社区模板的数据（供套用/下载） */
  app.get('/api/templates/community/:id', wrap(async (req, res) => {
    const row = await db.templateGet(Number(req.params.id));
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

  app.post('/api/admin/templates/:id/approve', requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
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
    const score = Number(req.body && req.body.score);
    if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: '评分需在 1-5 之间' });
    await db.ratingUpsert(id, req.session.userId, score);
    res.json({ ok: true, rating: await db.ratingStats(id) });
  }));

  /* ---- 模板收藏（切换） ---- */
  app.post('/api/templates/:id/favorite', requireAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
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

  /* 首页 / 管理页：读取 HTML 并把一次性 nonce 注入到 <script>/<style> 标签，
   * 与 CSP 的 'nonce-xxx' 指令配套（纵深防御注入的脚本/样式）。 */
  function serveHtml(file) {
    return (req, res) => {
      try {
        const fs = require('fs');
        let html = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
        const n = req.nonce || '';
        html = html
          .replace(/<script(\s|>)/g, '<script nonce="' + n + '"$1')
          .replace(/<style(\s|>)/g, '<style nonce="' + n + '"$1');
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
}

/* 启动兜底：任何未捕获的异常 / Promise 拒绝都打印清楚日志，
 * 避免「Exited with status 1」却看不到真正原因（Render 部署失败难排查）。 */
process.on('unhandledRejection', (reason) => {
  console.error('❌ 未捕获的 Promise 拒绝：', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获异常：', err);
  process.exit(1);
});
start().catch((err) => {
  console.error('❌ 应用启动失败：', err);
  process.exit(1);
});
