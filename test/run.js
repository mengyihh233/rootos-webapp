/* ============================================================
 * test/run.js — 最小测试套件（纯 Node，无第三方依赖）
 * 用法：node test/run.js   （或 npm test）
 * 覆盖：
 *   1) 单元测试：logic.js 的 esc / isRootBag / linkify
 *   2) 集成测试：起一个独立 SQLite 实例的 server，跑通
 *      注册 / 登录 / 登出 / 限流429 / 失败模式分析 / 文档解析 / 导入回显
 * ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name + ' (期望 ' + JSON.stringify(b) + ')', JSON.stringify(a) === JSON.stringify(b), '实际 ' + JSON.stringify(a)); }

/* ---------- 单元测试：logic.js ---------- */
console.log('\n[单元测试] logic.js');
const L = require('../public/logic.js');
eq('esc 转义 < > & "', L.esc('<b>&"x'), '&lt;b&gt;&amp;&quot;x');
ok('esc 转义单引号（防 JS 字符串注入）', L.esc("a'b") === 'a&#39;b', L.esc("a'b"));
ok('escJs 转义反斜杠+单引号（onclick 内联 JS 字符串注入防护）', L.escJs("');alert(1);//") === "\\&#39;);alert(1);//", JSON.stringify(L.escJs("');alert(1);//")));
ok('escJs 保留普通文本', L.escJs('cs_student.json') === 'cs_student.json', JSON.stringify(L.escJs('cs_student.json')));
ok('isRootBag 合法包', L.isRootBag({ rules: [], cats: [], tags: [], phases: [], daily: {} }) === true);
ok('isRootBag 缺 daily 判否', L.isRootBag({ rules: [], cats: [], tags: [], phases: [] }) === false);
ok('isRootBag 缺 phases 判否', L.isRootBag({ rules: [], cats: [], tags: [], daily: {} }) === false);
ok('isRootBag 非对象判否', L.isRootBag(null) === false);

const linkCases = [
  ['cs50.harvard.edu/x', true, '裸域名应链'],
  ['ielts.neea.cn', true, '裸域名应链'],
  ['https://cs229.stanford.edu/', true, 'http(s)应链'],
  ['看 CS61A(cs61a.org) 与 6.042J', true, '括号内域名应链'],
  ['课程 6.S081 与 18.06 不是网址', false, '课程号不误链'],
  ['邮箱 user@harvard.edu 不应被链', false, '邮箱不误链'],
  ['teachyourselfcs.com 很好', true, '裸域名应链'],
  ['正文 http://a.com 尾点。', true, '尾点不应入链接']
];
linkCases.forEach(([inp, shouldLink, desc]) => {
  const out = L.linkify(inp);
  const hasAnchor = out.includes('<a href=');
  ok('linkify: ' + desc, hasAnchor === shouldLink, out);
});

/* 模板「合并」模式的核心纯函数 */
ok('mergeById：保留当前 + 追加模板', JSON.stringify(L.mergeById([{id:'a',v:1}],[{id:'b',v:2}])) === JSON.stringify([{id:'a',v:1},{id:'b',v:2}]));
ok('mergeById：同 id 模板覆盖当前', JSON.stringify(L.mergeById([{id:'a',v:1}],[{id:'a',v:9}])) === JSON.stringify([{id:'a',v:9}]));
ok('mergeById：空当前不报错', L.mergeById(null,[{id:'x'}]).length === 1);
ok('mergeById：空模板不报错', L.mergeById([{id:'x'}],null).length === 1);
ok('mergeWithChoices：新增项始终追加', JSON.stringify(L.mergeWithChoices([{id:'a',v:1}],[{id:'a',v:9},{id:'b',v:2}],{})) === JSON.stringify([{id:'a',v:9},{id:'b',v:2}]));
ok('mergeWithChoices：默认用模板版(同id)', L.mergeWithChoices([{id:'a',v:1}],[{id:'a',v:9}],{})[0].v === 9);
ok('mergeWithChoices：choices[id]=false 保留当前版', L.mergeWithChoices([{id:'a',v:1}],[{id:'a',v:9}],{a:false})[0].v === 1);
ok('mergeWithChoices：choices 只影响指定 id', JSON.stringify(L.mergeWithChoices([{id:'a',v:1},{id:'c',v:0}],[{id:'a',v:9},{id:'c',v:7}],{a:false})) === JSON.stringify([{id:'a',v:1},{id:'c',v:7}]));
eq('mergeReviews：当前优先、按日期合并', L.mergeReviews({day:{'2026-08-07':{a:1}},week:{},month:{}}, {day:{'2026-08-07':{b:2},'2026-08-08':{c:3}},week:{},month:{}}),
  {day:{'2026-08-07':{a:1},'2026-08-08':{c:3}},week:{},month:{}});

/* ---------- 集成测试：起 server ---------- */
console.log('\n[集成测试] 后端 API');
const PORT = 4399;
const TMP_DB = path.join(os.tmpdir(), 'rootos_test_' + Date.now() + '.db');
process.env.PORT = PORT;
process.env.SESSION_SECRET = 'test-secret';
process.env.SQLITE_PATH = TMP_DB;
process.env.NODE_ENV = 'test';
process.env.ADMIN_TOKEN = 'test-admin-token';

const child = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.on('data', d => process.stderr.write('[srv] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUp() { for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${PORT}/api/me`); return true; } catch (e) { await sleep(200); } } return false; }

/* 极简 ZIP（store 无压缩）生成，造一个最小 .docx 给 /api/parse-doc 用 */
function crc32(buf) {
  let t = crc32.t; if (!t) { t = crc32.t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } }
  let crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeDocx(text) {
  const enc = s => Buffer.from(s, 'utf8');
  const doc = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>';
  const ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
  const files = { '[Content_Types].xml': ct, 'word/document.xml': doc };
  const local = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = enc(content), nameBuf = enc(name), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(0, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36); cen.writeUInt16LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const locBuf = Buffer.concat(local), cenBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(locBuf.length, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([locBuf, cenBuf, end]);
}

(async () => {
  const up = await waitUp();
  ok('server 启动', up);
  if (!up) { child.kill(); process.exit(1); }
  const base = `http://localhost:${PORT}`;
  const hd = { 'Content-Type': 'application/json' };
  const uname = 'tester_' + Date.now();

  // 注册
  let r = await fetch(base + '/api/register', { method: 'POST', headers: hd, body: JSON.stringify({ username: uname, password: 'pass123456' }) });
  ok('注册成功 200', r.status === 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];

  // 登录 / 登出 / 未登录 401
  r = await fetch(base + '/api/login', { method: 'POST', headers: hd, body: JSON.stringify({ username: uname, password: 'pass123456' }) });
  ok('登录成功 200', r.status === 200);
  r = await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } });
  ok('登出 200', r.status === 200);
  r = await fetch(base + '/api/me', { headers: { cookie } });
  ok('登出后再访问 /api/me → 401', r.status === 401);
  // 重新登录拿 cookie
  r = await fetch(base + '/api/login', { method: 'POST', headers: hd, body: JSON.stringify({ username: uname, password: 'pass123456' }) });
  const cookie2 = r.headers.get('set-cookie').split(';')[0];

  // 限流：连续错 20 次 → 第 20 次后 429
  let first429 = -1;
  for (let i = 0; i < 22; i++) {
    const rr = await fetch(base + '/api/login', { method: 'POST', headers: hd, body: JSON.stringify({ username: uname, password: 'WRONG' }) });
    if (rr.status === 429 && first429 === -1) first429 = i + 1;
  }
  ok('登录限流：错误过多返回 429', first429 > 0);
  // 正确密码在限流后仍可登录（不误伤）
  r = await fetch(base + '/api/login', { method: 'POST', headers: hd, body: JSON.stringify({ username: uname, password: 'pass123456' }) });
  ok('限流后正确密码仍能登录', r.status === 200, 'status=' + r.status);
  const cookie3 = r.headers.get('set-cookie').split(';')[0];

  // 失败模式分析：种子一个崩溃事件 + 支链勾选
  /* 乐观锁：先 GET 拿服务端 X-Data-Updated 作为 baseTs，PUT 携带（服务端已有数据时 baseTs=0 会被 409 拒绝） */
  r = await fetch(base + '/api/data', { headers: { cookie: cookie3 } });
  const baseTs = Number(new Date(r.headers.get('x-data-updated') || 0).getTime()) || 0;
  const bag = {
    rules: [
      { id: 'r1', cat: 'c_study', lv: 'lv0', t: '主线', on: true, parent: null },
      { id: 'r1b', cat: 'c_study', lv: 'lv0', t: '崩溃后改做', on: true, parent: 'r1' }
    ],
    cats: [{ id: 'c_study', name: '学习' }], levels: [{ id: 'lv0', name: 'L0' }], tags: [],
    phases: [], daily: { '2026-08-07': { checks: { r1b: true } } },
    events: [{ id: 'e1', type: 'crash', ruleId: 'r1', day: '2026-08-07', ts: Date.now() }],
    _baseTs: baseTs
  };
  r = await fetch(base + '/api/data', { method: 'PUT', headers: { ...hd, cookie: cookie3 }, body: JSON.stringify(bag) });
  ok('PUT 数据 200', r.status === 200);
  r = await fetch(base + '/api/me/failure-analysis', { headers: { cookie: cookie3 } });
  const fa = await r.json();
  ok('失败分析 totalCrashes=1', fa.totalCrashes === 1, JSON.stringify(fa));
  ok('失败分析 branchRate=100', fa.branchRate === 100);
  ok('失败分析 topCrashed 含「主线」', Array.isArray(fa.topCrashed) && fa.topCrashed.some(x => x.rule === '主线'));

  // 未登录访问失败分析 → 401
  r = await fetch(base + '/api/me/failure-analysis');
  ok('未登录失败分析 → 401', r.status === 401);

  // 导入回显：PUT 再 GET，字段一致
  r = await fetch(base + '/api/data', { headers: { cookie: cookie3 } });
  const got = await r.json();
  ok('GET 回显 rules 一致', got.rules.length === bag.rules.length);
  ok('GET /api/data 带 X-Data-Updated 服务器时间戳头（多端同步权威时钟）', !!r.headers.get('x-data-updated'), 'header=' + r.headers.get('x-data-updated'));
  ok('GET 回显 daily 一致', JSON.stringify(got.daily) === JSON.stringify(bag.daily));

  // 文档解析：.txt
  const txtB64 = Buffer.from('hello 规划 资源 测试').toString('base64');
  r = await fetch(base + '/api/parse-doc', { method: 'POST', headers: { ...hd, cookie: cookie3 }, body: JSON.stringify({ filename: 'a.txt', data: txtB64 }) });
  const txtRes = await r.json();
  ok('parse-doc .txt 抽取正确', txtRes.text === 'hello 规划 资源 测试', JSON.stringify(txtRes));

  // 文档解析：.docx（用极简 ZIP 造一个）
  const docxB64 = makeDocx('专升本 与 转专业 的三年规划').toString('base64');
  r = await fetch(base + '/api/parse-doc', { method: 'POST', headers: { ...hd, cookie: cookie3 }, body: JSON.stringify({ filename: 'p.docx', data: docxB64 }) });
  const docxRes = await r.json();
  ok('parse-doc .docx 抽取含关键词', (docxRes.text || '').includes('专升本') && (docxRes.text || '').includes('转专业'), JSON.stringify(docxRes).slice(0, 120));

  // 未登录解析 → 401
  r = await fetch(base + '/api/parse-doc', { method: 'POST', headers: hd, body: JSON.stringify({ filename: 'a.txt', data: txtB64 }) });
  ok('未登录解析文档 → 401', r.status === 401);

  // 安全头：CSP 存在
  r = await fetch(base + '/');
  ok('响应带 Content-Security-Policy', !!r.headers.get('content-security-policy'));
  ok('响应带 X-Content-Type-Options', r.headers.get('x-content-type-options') === 'nosniff');

  // 模板市场：静态目录可访问 + 模板可导入（与 applyBag 对称）
  r = await fetch(base + '/templates/index.json');
  ok('模板索引 200', r.status === 200);
  const idx = await r.json();
  ok('模板索引为数组且含 cs_student', Array.isArray(idx) && idx.some(x => x.id === 'cs_student'));
  r = await fetch(base + '/templates/cs_student.json');
  ok('CS 模板 JSON 200', r.status === 200);
  const tpl = await r.json();
  ok('CS 模板通过 isRootBag（可导入）', L.isRootBag(tpl) === true);

  // 社区模板上传 + 审核流程
  const tplData = { rules:[{id:'r1',cat:'c_study',t:'X',lv:'lv0',on:true}],
    cats:[{id:'c_study',name:'学习'}], tags:[{id:'t1',name:'T'}], phases:[{id:'p1',name:'P',parent:null}],
    daily:{}, events:[], reviews:{day:{},week:{},month:{}}, retros:[], resources:[], meta:{} };
  r = await fetch(base + '/api/templates', { method:'POST', headers: hd, body: JSON.stringify({ title:'T1', data: tplData }) });
  ok('未登录上传模板 → 401', r.status === 401);
  r = await fetch(base + '/api/templates', { method:'POST', headers: { ...hd, cookie: cookie3 }, body: JSON.stringify({ title:'我的模板', tags:['cs'], data: tplData }) });
  ok('登录上传模板 → 201', r.status === 201);
  r = await fetch(base + '/api/templates');
  ok('公开列表默认不含待审模板', !(await r.json()).some(x => x.title === '我的模板'));
  r = await fetch(base + '/api/admin/login', { method:'POST', headers: hd, body: JSON.stringify({ token:'test-admin-token' }) });
  ok('admin 登录 200', r.status === 200);
  const adminCookie = r.headers.get('set-cookie').split(';')[0];
  r = await fetch(base + '/api/admin/templates', { headers: { cookie: adminCookie } });
  const adminList = await r.json();
  ok('admin 模板列表含待审', r.status === 200 && adminList.some(x => x.title === '我的模板'));
  const tid = adminList.find(x => x.title === '我的模板').id;
  r = await fetch(base + '/api/admin/templates/' + tid + '/approve', { method:'POST', headers: { cookie: adminCookie }, body: JSON.stringify({}) });
  ok('admin 通过模板 → 200', r.status === 200);
  r = await fetch(base + '/api/templates');
  ok('通过后公开列表含该社区模板(source=community)', (await r.json()).some(x => x.title === '我的模板' && x.source === 'community'));
  r = await fetch(base + '/api/templates/community/' + tid);
  ok('community/:id 返回模板数据', r.status === 200 && (await r.json()).rules.length === 1);
  // 看板统计 + 管理端模板详情（审核预览用）
  r = await fetch(base + '/api/admin/stats', { headers: { cookie: adminCookie } });
  const stats = await r.json();
  ok('看板 stats 含 active7 与 tplStats', r.status === 200 && typeof stats.active7 === 'number' && typeof stats.tplStats === 'object' && stats.tplStats.pending >= 0);
  r = await fetch(base + '/api/admin/templates/' + tid, { headers: { cookie: adminCookie } });
  const tplDet = await r.json();
  ok('管理端模板详情接口返回 data（审核预览）', r.status === 200 && tplDet.data && Array.isArray(tplDet.data.rules));
  // 再上传一个并拒绝，验证拒绝后不出现在公开列表
  await fetch(base + '/api/templates', { method:'POST', headers: { ...hd, cookie: cookie3 }, body: JSON.stringify({ title:'待拒模板', data: tplData }) });
  const adminList2 = await (await fetch(base + '/api/admin/templates', { headers: { cookie: adminCookie } })).json();
  const tid2 = adminList2.find(x => x.title === '待拒模板').id;
  await fetch(base + '/api/admin/templates/' + tid2 + '/reject', { method:'POST', headers: { cookie: adminCookie }, body: JSON.stringify({}) });
  r = await fetch(base + '/api/templates');
  ok('拒绝后公开列表不含该模板', !(await r.json()).some(x => x.title === '待拒模板'));

  // 评分 + 收藏（针对已审核的社区模板 tid）
  r = await fetch(base + '/api/templates/' + tid + '/rate', { method:'POST', headers:{...hd,cookie:cookie3}, body: JSON.stringify({score:5}) });
  const rateRes = await r.json();
  ok('登录评分模板 → 200 且 avg=5', r.status===200 && rateRes.rating && rateRes.rating.avg===5, JSON.stringify(rateRes));
  r = await fetch(base + '/api/templates/' + tid + '/favorite', { method:'POST', headers:{...hd,cookie:cookie3} });
  let favRes = await r.json();
  ok('收藏模板 → favorited=true', r.status===200 && favRes.favorited===true);
  r = await fetch(base + '/api/templates/' + tid + '/favorite', { method:'POST', headers:{...hd,cookie:cookie3} });
  favRes = await r.json();
  ok('再次收藏 → favorited=false（toggle）', r.status===200 && favRes.favorited===false);
  r = await fetch(base + '/api/templates');
  const pubList = await r.json();
  const tplEntry = pubList.find(x => x.id === tid);
  ok('公开列表模板携带 rating 字段', tplEntry && typeof tplEntry.rating === 'object' && tplEntry.rating.avg === 5);

  // 站内通知：作者（上传者）在审批通过后应收到通知
  r = await fetch(base + '/api/notifications', { headers:{cookie:cookie3} });
  const notif = await r.json();
  ok('作者收到审批通过通知（unread>=1 且含 template_approved）', r.status===200 && notif.unread>=1 && Array.isArray(notif.list) && notif.list.some(n=>n.type==='template_approved'), JSON.stringify(notif).slice(0,160));
  r = await fetch(base + '/api/notifications/read', { method:'POST', headers:{cookie:cookie3} });
  ok('标记通知已读 → 200', r.status===200);
  r = await fetch(base + '/api/notifications', { headers:{cookie:cookie3} });
  ok('标记已读后 unread=0', (await r.json()).unread===0);

  // ---- 用户系统 v1.2：邮箱自动写入 / 微信绑定 / 改密 / SMTP 未配置降级 ----
  const mailUser = 'emailtest_' + Date.now() + '@test.com';
  r = await fetch(base + '/api/register', { method:'POST', headers:hd, body: JSON.stringify({ username: mailUser, password: 'pass123456' }) });
  const mc = r.headers.get('set-cookie').split(';')[0];
  ok('邮箱格式用户名注册成功', r.status === 200);
  r = await fetch(base + '/api/me', { headers:{cookie:mc} });
  const meJ = await r.json();
  ok('注册即自动写入 email（未验证）', r.status===200 && meJ.email===mailUser && meJ.email_verified===false, JSON.stringify(meJ).slice(0,140));
  r = await fetch(base + '/api/wechat/bind', { method:'POST', headers:{...hd,cookie:mc}, body: JSON.stringify({wechat:'wxid_test123'}) });
  ok('绑定微信号 → 200', r.status === 200);
  r = await fetch(base + '/api/me', { headers:{cookie:mc} });
  ok('/api/me 回显微信号', (await r.json()).wechat==='wxid_test123');
  r = await fetch(base + '/api/password/change', { method:'POST', headers:{...hd,cookie:mc}, body: JSON.stringify({old:'wrong-pass', next:'newpass123'}) });
  ok('改密：旧密码错误 → 400', r.status === 400);
  r = await fetch(base + '/api/password/change', { method:'POST', headers:{...hd,cookie:mc}, body: JSON.stringify({old:'pass123456', next:'newpass123'}) });
  ok('改密：正确 → 200', r.status === 200);
  r = await fetch(base + '/api/logout', { method:'POST', headers:{cookie:mc} });
  r = await fetch(base + '/api/login', { method:'POST', headers:hd, body: JSON.stringify({ username: mailUser, password: 'newpass123' }) });
  ok('改密后用新密码登录成功', r.status === 200);
  const mc2 = r.headers.get('set-cookie').split(';')[0]; /* 登出后旧 cookie 失效，重取 */
  r = await fetch(base + '/api/email/bind', { method:'POST', headers:hd, body: JSON.stringify({ email:'x@y.com', code:'123456' }) });
  ok('未登录绑定邮箱 → 401', r.status === 401);
  r = await fetch(base + '/api/email/send-code', { method:'POST', headers:{...hd,cookie:mc2}, body: JSON.stringify({ email:'someone@test.com' }) });
  ok('SMTP 未配置：发送验证码 → 503 降级提示', r.status === 503);
  r = await fetch(base + '/api/forgot/send-code', { method:'POST', headers:hd, body: JSON.stringify({ email:'someone@test.com' }) });
  ok('SMTP 未配置：找回密码 → 503 降级提示', r.status === 503);

  // ---- 微信小程序登录：未配置 503；配置假密钥时 code2session 被微信拒绝 → 400 ----
  r = await fetch(base + '/api/wechat/login', { method:'POST', headers:hd, body: JSON.stringify({ code:'fakecode' }) });
  ok('WX 未配置：小程序登录 → 503 降级提示', r.status === 503, 'status=' + r.status);
  r = await fetch(base + '/api/wechat/bind-openid', { method:'POST', headers:hd, body: JSON.stringify({ openid:'openid_x', username:'nobody', password:'x' }) });
  ok('bind-openid：账号密码错 → 401', r.status === 401);
  r = await fetch(base + '/api/data', { headers:{ authorization:'Bearer invalid-token'} });
  ok('无效 Bearer token → 401', r.status === 401);

  // ---- 分享快照 v0.6：创建（登录）→ 公开读取 → 数据只含结构不含打卡 ----
  r = await fetch(base + '/api/share/create', { method:'POST', headers:hd });
  ok('未登录创建分享 → 401', r.status === 401);
  r = await fetch(base + '/api/share/create', { method:'POST', headers:{...hd,cookie:cookie3}, body: JSON.stringify({}) });
  const shareJ = await r.json();
  ok('登录创建分享 → 200 且返回短 id', r.status===200 && shareJ.ok && shareJ.id && /^[a-z0-9]+$/.test(shareJ.id), JSON.stringify(shareJ).slice(0,120));
  r = await fetch(base + '/api/share/' + shareJ.id);
  const shared = await r.json();
  ok('公开读取分享 → 200 且含规则', r.status===200 && Array.isArray(shared.data.rules) && shared.data.rules.length>0);
  ok('分享数据不含打卡/事件', shared.data.daily===undefined && shared.data.events===undefined, 'keys=' + Object.keys(shared.data).join(','));
  r = await fetch(base + '/api/share/nonexistent');
  ok('不存在分享 → 404', r.status === 404);

  // ---- 账号合并 merge-web：微信自动注册账号 → 并入已有网页账号 ----
  const mergeWxUser = 'mergewx_' + Date.now();
  const mergeWebUser = 'mergeweb_' + Date.now();
  await fetch(base + '/api/register', { method:'POST', headers:hd, body: JSON.stringify({ username: mergeWxUser, password: 'pass123456' }) });
  await fetch(base + '/api/register', { method:'POST', headers:hd, body: JSON.stringify({ username: mergeWebUser, password: 'pass123456' }) });
  r = await fetch(base + '/api/wechat/bind-openid', { method:'POST', headers:hd, body: JSON.stringify({ openid:'openid_merge_1', username: mergeWxUser, password: 'pass123456' }) });
  const mwxJ = await r.json();
  ok('merge 前置：微信账号绑定 openid → 200', r.status===200 && mwxJ.ok && mwxJ.token);
  const mwxAuth = 'Bearer ' + mwxJ.token;
  /* 关键回归：当前账号自己持有 openid 时，合并到另一个账号不应报"已被绑定" */
  r = await fetch(base + '/api/account/merge-web', { method:'POST', headers:{...hd, authorization: mwxAuth}, body: JSON.stringify({ username: mergeWebUser, password: 'pass123456' }) });
  const mergeJ = await r.json();
  ok('merge-web：自身 openid 转移不误报 409 → 200 且返回目标账号 token', r.status===200 && mergeJ.ok && mergeJ.token, JSON.stringify(mergeJ).slice(0,120));
  r = await fetch(base + '/api/account/merge-web', { method:'POST', headers:{...hd, authorization: 'Bearer ' + mergeJ.token}, body: JSON.stringify({ username: mergeWebUser, password: 'pass123456' }) });
  ok('合并后已是目标账号 → 400', r.status === 400);
  r = await fetch(base + '/api/account/merge-web', { method:'POST', headers:{...hd, authorization: mwxAuth}, body: JSON.stringify({ username: mergeWebUser, password: 'wrongpass' }) });
  ok('merge-web：密码错误 → 401', r.status === 401);

  // ---- bind-openid：openid 被 wx_ 自动注册账号占用时允许合并转移（登录页绑定场景）----
  const wxTemp = 'wx_' + Date.now().toString(36).slice(0, 10);
  const bindWebUser = 'bindweb_' + Date.now();
  await fetch(base + '/api/register', { method:'POST', headers:hd, body: JSON.stringify({ username: wxTemp, password: 'pass123456' }) });
  await fetch(base + '/api/register', { method:'POST', headers:hd, body: JSON.stringify({ username: bindWebUser, password: 'pass123456' }) });
  /* 模拟：openid 先被 wx_ 临时账号占用（微信自动注册） */
  r = await fetch(base + '/api/wechat/bind-openid', { method:'POST', headers:hd, body: JSON.stringify({ openid:'openid_bind_1', username: wxTemp, password: 'pass123456' }) });
  ok('前置：openid 绑定到 wx_ 临时账号 → 200', r.status === 200);
  /* 网页账号绑定同一 openid → 应自动合并转移（不再 409） */
  r = await fetch(base + '/api/wechat/bind-openid', { method:'POST', headers:hd, body: JSON.stringify({ openid:'openid_bind_1', username: bindWebUser, password: 'pass123456' }) });
  const bindJ = await r.json();
  ok('bind-openid：wx_ 占用时可合并转移 → 200 且返回目标账号 token', r.status===200 && bindJ.ok && bindJ.token, JSON.stringify(bindJ).slice(0,120));

  // CSP 纵深：object-src none + base-uri self（frame-ancestors 未加，以兼容 WorkBuddy 预览跨域 iframe）
  // 注意：nonce 与 'unsafe-inline' 同现会被浏览器忽略 unsafe-inline，导致 style=""/onclick="" 全被拦，
  // 因此 CSP 不得再含 'nonce-（本站大量内联样式/事件，重构前只能保留 unsafe-inline）
  r = await fetch(base + '/');
  const csp = r.headers.get('content-security-policy') || '';
  ok('CSP 不再混用 nonce（防止 unsafe-inline 被浏览器忽略）', !csp.includes("'nonce-"));
  ok('CSP 含 object-src none', csp.includes("object-src 'none'"));
  ok('CSP 含 base-uri self', csp.includes("base-uri 'self'"));

  child.kill();
  try { fs.unlinkSync(TMP_DB); fs.unlinkSync(TMP_DB + '-wal'); fs.unlinkSync(TMP_DB + '-shm'); } catch (e) {}

  console.log('\n========================================');
  console.log(`结果：通过 ${pass} / 失败 ${fail}`);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})();
