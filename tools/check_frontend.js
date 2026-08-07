/* 前端静态自检：抽出 index.html 的内联 <script>，做语法解析 + 悬空引用扫描 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');

/* 1) 抽脚本 */
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
if (!scripts.length) { console.error('❌ 没找到内联脚本'); process.exit(1); }
const code = scripts.join('\n;\n');
console.log(`共 ${scripts.length} 段脚本，合计 ${code.length} 字符`);

/* 2) 语法解析 */
try {
  new vm.Script(code, { filename: 'index.html<script>' });
  console.log('✅ 语法解析通过');
} catch (e) {
  console.error('❌ 语法错误：', e.message);
  process.exit(1);
}

/* 3) 已删除模块的残留引用扫描 */
const banned = [
  'renderLife', 'apptWarning', 'meta.appt', "$('#appt')", '#apptWarn',
  'ghUpload', 'githubBackup', 'githubRestore', 'ghToken', 'setGhStatus',
  'saveGhToken', 'ghErr', 'GH_REPO', 'GH_BP',
  'syncPush', 'syncPull', 'bagData', 'createSyncKey', 'saveSyncKey', 'ghSyncUpload',
  'migrate(', 'pos_v7', 'pos_v8', 'pos_v9',
  '嗜睡', '复诊', 'porn', 'Porn'
];
let bad = 0;
banned.forEach(k => {
  const idx = html.indexOf(k);
  if (idx !== -1) {
    const line = html.slice(0, idx).split('\n').length;
    console.error(`❌ 残留引用 "${k}" @ line ${line}`);
    bad++;
  }
});
if (!bad) console.log('✅ 无已删除模块的残留引用');

/* 4) onclick / id 双向核对：HTML 里调用的函数必须在脚本里定义 */
const called = new Set();
[...html.matchAll(/on(?:click|change|input)\s*=\s*"([a-zA-Z_$][\w$]*)\s*\(/g)].forEach(m => called.add(m[1]));
const defined = new Set();
[...code.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)].forEach(m => defined.add(m[1]));
[...code.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)].forEach(m => defined.add(m[1]));
const kw = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'catch']);
const missing = [...called].filter(f => !defined.has(f) && !kw.has(f));
if (missing.length) { console.error('❌ HTML 调用了未定义的函数：', missing.join(', ')); bad++; }
else console.log(`✅ HTML 中 ${called.size} 个事件处理函数全部有定义`);

/* 5) 脚本里 $('#xxx') 引用的元素必须在 HTML 里存在 */
const ids = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(m => m[1]));
const refs = new Set([...code.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]));
[...code.matchAll(/getElementById\('([\w-]+)'\)/g)].forEach(m => refs.add(m[1]));
const ghost = [...refs].filter(r => !ids.has(r));
if (ghost.length) { console.error('❌ 脚本引用了不存在的元素 id：', ghost.join(', ')); bad++; }
else console.log(`✅ 脚本引用的 ${refs.size} 个元素 id 全部存在`);

process.exit(bad ? 1 : 0);
