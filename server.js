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
const db = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'rootos-dev-secret-change-me';

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
    meta: { version: 'webapp-1.0' }
  };
}

/* ---------- Express ---------- */
async function start() {
  await db.init();

  const app = express();
  /* 部署在 Nginx / Caddy / Render 反代之后时必须开启，
   * 否则 NODE_ENV=production 下 cookie 的 secure 标志会导致登录态无法建立 */
  app.set('trust proxy', 1);
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

  function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: '未登录' });
    next();
  }

  /* 注册 */
  app.post('/api/register', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (username.length < 2) return res.status(400).json({ error: '用户名至少 2 个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const exists = await db.userByName(username);
    if (exists) return res.status(409).json({ error: '用户名已被占用' });
    const pw_hash = bcrypt.hashSync(password, 10);
    const uid = await db.createUser(username, pw_hash);
    await db.profileSet(uid, JSON.stringify(defaultBag()));
    req.session.userId = uid;
    req.session.username = username;
    res.json({ ok: true, username });
  }));

  /* 登录 */
  app.post('/api/login', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const u = await db.userByName(username);
    if (!u || !bcrypt.compareSync(password, u.pw_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    req.session.userId = u.id;
    req.session.username = u.username;
    res.json({ ok: true, username: u.username });
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

  /* 静态前端 */
  app.use(express.static(path.join(__dirname, 'public')));

  app.listen(PORT, () => {
    console.log(`✅ 底层创造者OS 多用户版运行中： http://localhost:${PORT}`);
  });
}

start();
