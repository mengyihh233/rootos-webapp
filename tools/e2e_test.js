/* 多用户端到端测试：注册 / 登录 / 数据隔离 / 持久化 / 越权拦截
 * 自带 cookie jar（curl 在 localhost 下不写会话 cookie，必须手动管理） */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg); }
}

/* 极简 cookie jar：每个 client 独立，模拟不同浏览器 */
function newClient(name) {
  const jar = new Map();
  return {
    name,
    async req(method, url, body) {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (jar.size) headers['Cookie'] = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(BASE + url, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      setCookies.forEach(sc => {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data };
    }
  };
}

const rnd = Math.random().toString(36).slice(2, 7);
const A = 'alice_' + rnd, B = 'bob_' + rnd;

(async () => {
  console.log(`\n=== 多用户端到端测试 @ ${BASE} ===\n`);

  const a = newClient('A'), b = newClient('B'), anon = newClient('anon');

  console.log('[1] 未登录访问受保护接口');
  ok((await anon.req('GET', '/api/me')).status === 401, '未登录 GET /api/me → 401');
  ok((await anon.req('GET', '/api/data')).status === 401, '未登录 GET /api/data → 401');
  ok((await anon.req('PUT', '/api/data', { rules: [] })).status === 401, '未登录 PUT /api/data → 401');

  console.log('\n[2] 注册校验');
  ok((await a.req('POST', '/api/register', { username: 'x', password: 'abcdef' })).status === 400, '用户名过短 → 400');
  ok((await a.req('POST', '/api/register', { username: A, password: '123' })).status === 400, '密码过短 → 400');

  console.log('\n[3] 用户 A 注册并自动登录');
  const regA = await a.req('POST', '/api/register', { username: A, password: 'pw123456' });
  ok(regA.status === 200 && regA.data.ok, `注册 ${A} 成功`);
  const meA = await a.req('GET', '/api/me');
  ok(meA.status === 200 && meA.data.username === A, '注册后会话已建立');
  ok((await a.req('POST', '/api/register', { username: A, password: 'pw123456' })).status === 409, '重复用户名 → 409');

  console.log('\n[4] 默认模板检查（应无医学/成人内容，保留戒断链）');
  const dA = await a.req('GET', '/api/data');
  const bag = dA.data;
  ok(dA.status === 200, 'GET /api/data → 200');
  ok(Array.isArray(bag.rules) && bag.rules.length >= 20, `默认规则 ${bag.rules.length} 条（>=20）`);
  ok(bag.cats.some(c => c.id === 'c_quit'), '保留「戒断」门类');
  ok(bag.rules.some(r => r.cat === 'c_quit' && /冷却/.test(r.t)), '保留「15 分钟冷却」戒断规则');
  ok(bag.rules.some(r => r.parent === 'r_lif1'), '保留支链结构（parent=r_lif1）');
  const dump = JSON.stringify(bag);
  ok(!/医学|复诊|嗜睡|porn/i.test(dump), '默认模板无医学/成人内容残留');
  ok(bag.phases.length === 4 && /系统冷启动/.test(bag.phases[0].name), '阶段模板为通用版');
  ok(bag.phases[0].start === new Date().toLocaleDateString('sv'), '阶段起始日按注册当天动态生成');

  console.log('\n[5] A 写入数据并验证持久化');
  const mod = JSON.parse(JSON.stringify(bag));
  mod.rules.push({ id: 'r_alice', cat: 'c_study', lv: 'lv0', t: 'ALICE 私有规则', on: true, parent: null, seq: 99 });
  mod.daily['2026-08-07'] = { checks: { r_stu1: true }, tags: [], sleep: 7.5, note: 'alice note', task: '', broken: {} };
  ok((await a.req('PUT', '/api/data', mod)).status === 200, 'PUT 保存成功');
  const dA2 = (await a.req('GET', '/api/data')).data;
  ok(dA2.rules.some(r => r.id === 'r_alice'), '重新读取：私有规则已持久化');
  ok(dA2.daily['2026-08-07'].sleep === 7.5, '重新读取：睡眠时长已持久化');

  console.log('\n[6] 用户 B 注册 → 数据隔离');
  ok((await b.req('POST', '/api/register', { username: B, password: 'pw123456' })).status === 200, `注册 ${B} 成功`);
  const dB = (await b.req('GET', '/api/data')).data;
  ok(!dB.rules.some(r => r.id === 'r_alice'), 'B 看不到 A 的私有规则');
  ok(Object.keys(dB.daily).length === 0, 'B 的打卡记录为空（未串号）');
  ok((await b.req('GET', '/api/me')).data.username === B, 'B 的会话是 B 自己');
  ok((await a.req('GET', '/api/me')).data.username === A, 'A 的会话未被 B 覆盖');

  console.log('\n[7] 令牌护栏');
  const evil = JSON.parse(JSON.stringify(dB));
  evil.meta = { version: 'x', ghToken: 'ghp_SHOULD_BE_STRIPPED' };
  await b.req('PUT', '/api/data', evil);
  const dB2 = (await b.req('GET', '/api/data')).data;
  ok(!dB2.meta.ghToken, 'meta.ghToken 已被服务端剥离');

  console.log('\n[8] 登出 / 重新登录');
  ok((await a.req('POST', '/api/logout')).status === 200, 'A 登出成功');
  ok((await a.req('GET', '/api/me')).status === 401, '登出后 /api/me → 401');
  ok((await a.req('POST', '/api/login', { username: A, password: 'wrongpw' })).status === 401, '错误密码 → 401');
  const relog = await a.req('POST', '/api/login', { username: A, password: 'pw123456' });
  ok(relog.status === 200, '正确密码重新登录成功');
  const dA3 = (await a.req('GET', '/api/data')).data;
  ok(dA3.rules.some(r => r.id === 'r_alice'), '重新登录后数据仍在（跨会话持久化）');
  ok(dA3.daily['2026-08-07'].note === 'alice note', '重新登录后打卡记录仍在');

  console.log('\n[9] 静态前端可访问');
  const page = await fetch(BASE + '/');
  const htmlText = await page.text();
  ok(page.status === 200, 'GET / → 200');
  ok(/id="auth"/.test(htmlText), '首页含登录遮罩层');
  ok(!/医学|复诊|嗜睡/.test(htmlText), '首页 HTML 无医学模块残留');

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
