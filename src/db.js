/**
 * Database layer. Two backends with the same async API:
 *   - SQLite file (default, for a single server / local development)
 *   - PostgreSQL when DATABASE_URL is set (e.g. Supabase free tier, used with Render)
 *
 * Queries use `?` placeholders; the Postgres adapter rewrites them to $1, $2, …
 *
 *   await db.get(sql, ...params)     -> first row or undefined
 *   await db.all(sql, ...params)     -> rows
 *   await db.run(sql, ...params)     -> { changes }
 *   await db.insert(sql, ...params)  -> new row id
 *   await db.tx(async (t) => { ... }) -> same API inside one transaction
 */
const fs = require('fs');
const config = require('./config');

const ID = { sqlite: 'INTEGER PRIMARY KEY AUTOINCREMENT', pg: 'BIGSERIAL PRIMARY KEY' };
const REF = { sqlite: 'INTEGER', pg: 'BIGINT' };
const BLOB = { sqlite: 'BLOB', pg: 'BYTEA' };
const TABLES = ['users', 'sessions', 'items', 'photos', 'responses', 'notifications', 'push_subscriptions', 'settings', 'blobs'];

function schema(kind) {
  const id = ID[kind];
  const ref = REF[kind];
  return `
CREATE TABLE IF NOT EXISTS users (
  id            ${id},
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  college_id    TEXT,
  department    TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  is_banned     INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    ${ref} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id             ${id},
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  category       TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  event_date     TEXT,
  secret_detail  TEXT,
  handover       TEXT,
  user_id        ${ref} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'open',
  close_note     TEXT,
  closed_by      TEXT,
  extensions     INTEGER NOT NULL DEFAULT 0,
  reminder_sent  INTEGER NOT NULL DEFAULT 0,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL,
  closed_at      BIGINT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);

CREATE TABLE IF NOT EXISTS photos (
  id       ${id},
  item_id  ${ref} NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id);

CREATE TABLE IF NOT EXISTS responses (
  id         ${id},
  item_id    ${ref} NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id    ${ref} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  photo      TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  decided_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_responses_item ON responses(item_id);
CREATE INDEX IF NOT EXISTS idx_responses_user ON responses(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         ${id},
  user_id    ${ref} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         ${id},
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_id    ${ref} REFERENCES users(id) ON DELETE SET NULL,
  scope      TEXT NOT NULL DEFAULT 'all',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Photo bytes, used when there is no persistent disk (Postgres mode).
CREATE TABLE IF NOT EXISTS blobs (
  filename   TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       ${BLOB[kind]} NOT NULL,
  created_at BIGINT NOT NULL
);
`;
}

// ---------------------------------------------------------------- SQLite
function sqliteAdapter(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  let conn = null;
  let cache = new Map();
  let onWrite = () => {};

  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = conn.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const write = (fn) => (...args) => {
    const r = fn(...args);
    onWrite();
    return r;
  };
  const api = {
    kind: 'sqlite',
    file,
    get: async (sql, ...p) => stmt(sql).get(...p),
    all: async (sql, ...p) => stmt(sql).all(...p),
    run: async (sql, ...p) => write(() => ({ changes: Number(stmt(sql).run(...p).changes) }))(),
    insert: async (sql, ...p) => write(() => Number(stmt(sql).run(...p).lastInsertRowid))(),
    // node:sqlite is synchronous, so a transaction can't interleave with other requests.
    tx: async (fn) => {
      conn.exec('BEGIN');
      try {
        const r = await fn(api);
        conn.exec('COMMIT');
        onWrite();
        return r;
      } catch (err) {
        conn.exec('ROLLBACK');
        throw err;
      }
    },
    close: async () => conn && conn.close(),
    /** Open (or re-open) the database file. */
    open() {
      if (conn) conn.close();
      cache = new Map();
      conn = new DatabaseSync(file);
      conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      conn.exec(schema('sqlite'));
    },
    /** Write a consistent copy of the whole database to `target`. */
    snapshotTo(target) {
      fs.rmSync(target, { force: true });
      conn.prepare('VACUUM INTO ?').run(target);
    },
    setOnWrite(fn) { onWrite = fn; },
  };
  return api;
}

// ---------------------------------------------------------------- Postgres
function pgAdapter(url) {
  const pg = require('pg');
  // BIGINT and COUNT(*) come back as strings by default; our numbers fit safely in JS.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));

  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));

  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  const make = (q) => ({
    kind: 'pg',
    get: async (sql, ...p) => (await q(toPg(sql), p)).rows[0],
    all: async (sql, ...p) => (await q(toPg(sql), p)).rows,
    run: async (sql, ...p) => ({ changes: (await q(toPg(sql), p)).rowCount }),
    insert: async (sql, ...p) => Number((await q(`${toPg(sql)} RETURNING id`, p)).rows[0].id),
  });

  const api = make((text, values) => pool.query(text, values));
  api.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(make((text, values) => client.query(text, values)));
      await client.query('COMMIT');
      return r;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  api.close = () => pool.end();
  api.init = async () => {
    // Several app instances may start at once; serialise schema creation.
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(424242)');
      await client.query(schema('pg'));
      // Supabase publishes the public schema through its REST API. With row level security on and
      // no policies, that API sees nothing; this app connects as the table owner and is unaffected.
      for (const t of TABLES) await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
      client.release();
    }
  };
  return api;
}

const db = config.DATABASE_URL
  ? pgAdapter(config.DATABASE_URL)
  : sqliteAdapter(process.env.DB_FILE || config.DB_FILE);

/** Must be awaited once before serving requests. */
db.ready = (async () => {
  if (db.kind === 'pg') {
    await db.init();
  } else {
    if (config.GCS_BUCKET) await require('./snapshot').restore(db);
    db.open();
    if (config.GCS_BUCKET) require('./snapshot').attach(db);
  }
  return db;
})();

// ---------------------------------------------------------------- settings helpers
const settingsCache = new Map();

async function getSetting(key) {
  if (settingsCache.has(key)) return settingsCache.get(key);
  const value = (await db.get('SELECT value FROM settings WHERE key = ?', key))?.value;
  settingsCache.set(key, value);
  return value;
}

async function setSetting(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  settingsCache.set(key, value);
}

async function getCollectionPoints() {
  const raw = await getSetting('collection_points');
  return (raw ? JSON.parse(raw) : config.defaultCollectionPoints).filter(Boolean);
}

async function getTheme() {
  const t = await getSetting('theme');
  return config.themes.some((x) => x.id === t) ? t : config.themes[0].id;
}

module.exports = { db, getSetting, setSetting, getCollectionPoints, getTheme };
