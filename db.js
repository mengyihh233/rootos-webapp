/* =====================================================================
 * db.js — 数据库适配层
 * ---------------------------------------------------------------------
 * 默认：SQLite（本地开发 / 自托管 VPS，单文件 data.db）
 * 若设置环境变量 DATABASE_URL（Postgres 连接串，如 Neon），
 * 则自动切换到 Postgres，便于部署到无持久化磁盘的免费 Node 平台。
 *
 * 两套实现暴露完全一致的异步接口，server.js 的业务代码无需关心底层引擎。
 * 新增字段 / 改模板都不用动这里（数据整包存成 JSON 字符串）。
 * ===================================================================== */
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;

let sqlite = null;   // better-sqlite3 实例
let pool = null;     // pg Pool 实例

const SCHEMA_SQLITE = {
  users: `
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE NOT NULL,
      pw_hash    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  profiles: `
    CREATE TABLE IF NOT EXISTS profiles (
      user_id    INTEGER PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`
};

const SCHEMA_PG = {
  users: `
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      pw_hash    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT NOW()
    )`,
  profiles: `
    CREATE TABLE IF NOT EXISTS profiles (
      user_id    INTEGER PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT NOW()
    )`
};

async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await pool.query(SCHEMA_PG.users);
    await pool.query(SCHEMA_PG.profiles);
    console.log('✅ 数据库：已连接 Postgres（DATABASE_URL）');
  } else {
    const Database = require('better-sqlite3');
    sqlite = new Database(path.join(__dirname, 'data.db'));
    sqlite.pragma('journal_mode = WAL');
    sqlite.exec(SCHEMA_SQLITE.users);
    sqlite.exec(SCHEMA_SQLITE.profiles);
    console.log('✅ 数据库：已连接本地 SQLite（data.db）');
  }
}

async function userByName(username) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return r.rows[0];
  }
  return sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

async function createUser(username, pw_hash) {
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
  if (USE_PG) {
    const r = await pool.query('SELECT data FROM profiles WHERE user_id = $1', [uid]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const row = sqlite.prepare('SELECT data FROM profiles WHERE user_id = ?').get(uid);
  return row ? row.data : null;
}

async function profileSet(uid, dataStr) {
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
  const sql = `SELECT u.id, u.username, u.created_at, p.updated_at, p.data
               FROM users u LEFT JOIN profiles p ON p.user_id = u.id
               ORDER BY u.id`;
  if (USE_PG) {
    const r = await pool.query(sql);
    return r.rows.map(row => ({
      id: row.id, username: row.username,
      created_at: row.created_at, updated_at: row.updated_at, data: row.data
    }));
  }
  return sqlite.prepare(sql).all().map(row => ({
    id: row.id, username: row.username,
    created_at: row.created_at, updated_at: row.updated_at, data: row.data
  }));
}

module.exports = { init, userByName, createUser, profileGet, profileSet, adminUsers, USE_PG };
