/* =====================================================================
 * tools/view_users.js — 本地查看线上数据库的用户与档案数据
 * ---------------------------------------------------------------------
 * 用法：
 *   node tools/view_users.js                 # 列出所有用户概览
 *   node tools/view_users.js --json          # 同时打印每个用户完整档案(JSON)
 *   node tools/view_users.js --user=alice    # 只看某用户完整档案
 *
 * 连接串来源（按顺序）：
 *   1) 环境变量 DATABASE_URL
 *   2) 同级 .env 文件
 *   3) tools/.neon_url.tmp 文件
 * （均不含密码硬编码，临时文件用完即删，不进仓库）
 * ===================================================================== */
const fs = require('fs');
const path = require('path');

function loadUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // .env 文件：提取 DATABASE_URL=... 的值
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
    if (m) return m[1];
  }
  // .neon_url.tmp 文件：纯连接串，直接返回
  const tmpPath = path.join(__dirname, '.neon_url.tmp');
  if (fs.existsSync(tmpPath)) return fs.readFileSync(tmpPath, 'utf8').trim();
  return null;
}

const url = loadUrl();
if (!url) {
  console.error('❌ 找不到 DATABASE_URL。请设置环境变量，或在 .env / tools/.neon_url.tmp 中提供。');
  process.exit(1);
}

const { Pool } = require('pg');
const args = process.argv.slice(2);
const showJson = args.includes('--json');
const userArg = (args.find(a => a.startsWith('--user=') || a.startsWith('--u=')) || '').split('=')[1];

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

function stat(data) {
  if (!data) return { rules: 0, phases: 0, cats: 0, tags: 0 };
  let d;
  try { d = typeof data === 'string' ? JSON.parse(data) : data; }
  catch { return { rules: 0, phases: 0, cats: 0, tags: 0 }; }
  return {
    rules: d.rules ? d.rules.length : 0,
    phases: d.phases ? d.phases.length : 0,
    cats: d.cats ? d.cats.length : 0,
    tags: d.tags ? d.tags.length : 0,
  };
}

(async () => {
  const u = await pool.query('SELECT id, username, created_at FROM users ORDER BY id');
  console.log(`\n=== 用户列表（共 ${u.rowCount} 个）===`);
  if (u.rowCount === 0) console.log('（暂无注册用户）');
  for (const r of u.rows) {
    const p = await pool.query('SELECT data, updated_at FROM profiles WHERE user_id = $1', [r.id]);
    const s = stat(p.rows[0] ? p.rows[0].data : null);
    console.log(
      `#${r.id}  ${r.username}\n` +
      `    注册: ${r.created_at}\n` +
      `    档案: ${s.rules}定式 / ${s.phases}阶段 / ${s.cats}门类 / ${s.tags}标签\n` +
      `    更新: ${p.rows[0] ? p.rows[0].updated_at : '—'}`
    );
    if (userArg && r.username === userArg && p.rows[0]) {
      const d = typeof p.rows[0].data === 'string' ? JSON.parse(p.rows[0].data) : p.rows[0].data;
      console.log('\n--- 完整档案 JSON ---\n' + JSON.stringify(d, null, 2));
    } else if (showJson && p.rows[0]) {
      const d = typeof p.rows[0].data === 'string' ? JSON.parse(p.rows[0].data) : p.rows[0].data;
      console.log('  完整档案: ' + JSON.stringify(d));
    }
  }
  await pool.end();
})().catch(e => { console.error('查询失败:', e.message); process.exit(1); });
