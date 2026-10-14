const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || config.DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  college_id    TEXT,
  department    TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',      -- user | admin
  is_banned     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  type           TEXT NOT NULL,                    -- lost | found
  title          TEXT NOT NULL,
  category       TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  event_date     TEXT,                             -- YYYY-MM-DD when lost/found
  secret_detail  TEXT,                             -- found items: only finder/admin can see
  handover       TEXT,                             -- found items: 'me' or a collection point name
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'open',     -- open | resolved | closed | expired
  close_note     TEXT,
  closed_by      TEXT,                             -- owner | admin | system
  extensions     INTEGER NOT NULL DEFAULT 0,
  reminder_sent  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  closed_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);

CREATE TABLE IF NOT EXISTS photos (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  filename TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_item ON photos(item_id);

CREATE TABLE IF NOT EXISTS responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  photo      TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',      -- pending | accepted | rejected | withdrawn
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_responses_item ON responses(item_id);
CREATE INDEX IF NOT EXISTS idx_responses_user ON responses(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scope      TEXT NOT NULL DEFAULT 'all',          -- all | mine
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

function getCollectionPoints() {
  const raw = getSetting('collection_points');
  const list = raw ? JSON.parse(raw) : config.defaultCollectionPoints;
  return list.filter(Boolean);
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, getSetting, setSetting, getCollectionPoints, transaction };
