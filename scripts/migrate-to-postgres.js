#!/usr/bin/env node
/**
 * Copy everything from a SQLite database file into Postgres (e.g. when moving to Supabase).
 *
 *   DATABASE_URL="postgresql://…" node scripts/migrate-to-postgres.js lostfound.db [--photos-dir ./photos] [--force]
 *
 * Get the SQLite file from Google Cloud Storage first:
 *   gcloud storage cp gs://<bucket>/db/lostfound.db .
 * If the new host has no GCS_BUCKET (e.g. Render), also copy the photos into the database:
 *   gcloud storage cp -r gs://<bucket>/photos .   then add  --photos-dir ./photos
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--photos-dir');
const photosDir = args.includes('--photos-dir') ? args[args.indexOf('--photos-dir') + 1] : null;
const force = args.includes('--force');

if (!process.env.DATABASE_URL || !file || !fs.existsSync(file)) {
  console.error('Usage: DATABASE_URL="postgresql://…" node scripts/migrate-to-postgres.js <lostfound.db> [--photos-dir <dir>] [--force]');
  process.exit(1);
}

// Tables in foreign-key order.
const TABLES = ['users', 'sessions', 'items', 'photos', 'responses', 'notifications', 'push_subscriptions', 'settings', 'blobs'];
const SERIAL = ['users', 'items', 'photos', 'responses', 'notifications', 'push_subscriptions'];

(async () => {
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(path.resolve(file), { readOnly: true });
  const { db } = require('../src/db');
  await db.ready;

  const existing = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  if (existing && !force) {
    console.error(`Postgres already has ${existing} users. Re-run with --force to wipe it and copy again.`);
    process.exit(1);
  }

  await db.tx(async (t) => {
    if (force) for (const table of [...TABLES].reverse()) await t.run(`DELETE FROM ${table}`);
    for (const table of TABLES) {
      const hasTable = src.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!hasTable) continue;
      const rows = src.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        const cols = Object.keys(row);
        const values = cols.map((c) => (row[c] instanceof Uint8Array ? Buffer.from(row[c]) : row[c]));
        await t.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...values);
      }
      console.log(`${table}: ${rows.length} rows`);
    }
    for (const table of SERIAL) {
      await t.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table}`);
    }
    if (photosDir) {
      const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
      let n = 0;
      for (const name of fs.readdirSync(photosDir)) {
        if (!MIME[path.extname(name)]) continue;
        await t.run('INSERT INTO blobs (filename, mime, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (filename) DO NOTHING',
          name, MIME[path.extname(name)], fs.readFileSync(path.join(photosDir, name)), Date.now());
        n++;
      }
      console.log(`photos imported: ${n}`);
    }
  });

  await db.close();
  src.close();
  console.log('Done. Set DATABASE_URL on your host and redeploy.');
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
