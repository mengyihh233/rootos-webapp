/* 数据迁移：Neon Postgres → 腾讯云 PostgreSQL（或任意 Postgres）
 *
 * 用法：
 *   node tools/migrate_pg.js <源连接串> <目标连接串>
 * 例：
 *   node tools/migrate_pg.js "postgresql://neon_user:xxx@ep-xxx.aws.neon.tech/neondb?sslmode=require" "postgresql://rootos_user:xxx@pg-xxx.sql.tencentcdb.com:5432/rootos"
 *
 * 说明：
 * - 目标库已由 db.js init 建好表（云托管启动时会自动建表），本脚本只搬数据
 * - 全表清空目标库（幂等可重跑），再按主键插入
 * - 表：users / profiles / templates / notifications / ratings / favorites
 */
const { Client } = require('pg');

const [srcUrl, dstUrl] = process.argv.slice(2);
if (!srcUrl || !dstUrl) {
  console.error('用法: node tools/migrate_pg.js <源连接串> <目标连接串>');
  process.exit(1);
}

const TABLES = ['favorites', 'ratings', 'notifications', 'templates', 'profiles', 'users'];

async function main() {
  const src = new Client({ connectionString: srcUrl, ssl: { rejectUnauthorized: false } });
  const dst = new Client({ connectionString: dstUrl, ssl: { rejectUnauthorized: false } });
  await src.connect();
  await dst.connect();
  console.log('✅ 已连接源库与目标库');

  for (const t of TABLES) {
    const rows = (await src.query(`SELECT * FROM ${t}`)).rows;
    await dst.query(`TRUNCATE ${t} RESTART IDENTITY CASCADE`);
    if (!rows.length) { console.log(`  ${t}: 0 行（跳过）`); continue; }
    const cols = Object.keys(rows[0]);
    const colSql = cols.map(c => `"${c}"`).join(',');
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    for (const r of rows) {
      await dst.query(`INSERT INTO ${t} (${colSql}) VALUES (${ph})`, cols.map(c => r[c]));
    }
    console.log(`  ${t}: ${rows.length} 行迁移完成`);
  }

  await src.end();
  await dst.end();
  console.log('\n🎉 迁移完成！');
}

main().catch(e => { console.error('❌ 迁移失败：', e.message); process.exit(1); });
