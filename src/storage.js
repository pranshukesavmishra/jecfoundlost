/**
 * Photo storage.
 *   SQLite mode: files live in DATA_DIR/uploads on disk.
 *   Postgres mode: bytes live in the `blobs` table, so free hosts without a disk lose nothing on redeploy.
 * Photos are always referenced as /uploads/<filename>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const config = require('./config');
const { db } = require('./db');

const inDb = !!config.DATABASE_URL;
// Where multer writes incoming files before they are stored.
const INCOMING_DIR = inDb ? path.join(os.tmpdir(), 'jlf-incoming') : config.UPLOAD_DIR;
fs.mkdirSync(INCOMING_DIR, { recursive: true });

const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const SAFE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

/** Move freshly uploaded multer files into permanent storage. */
async function persist(files) {
  if (!inDb) return;
  for (const f of files) {
    const data = await fs.promises.readFile(f.path);
    await db.run('INSERT INTO blobs (filename, mime, data, created_at) VALUES (?, ?, ?, ?)',
      f.filename, MIME[path.extname(f.filename)] || 'application/octet-stream', data, Date.now());
    fs.rm(f.path, { force: true }, () => {});
  }
}

/** Delete stored photos by filename. */
async function remove(filenames) {
  const names = (filenames || []).filter(Boolean).map((n) => path.basename(n));
  if (!names.length) return;
  if (inDb) {
    for (const n of names) await db.run('DELETE FROM blobs WHERE filename = ?', n);
  } else {
    for (const n of names) fs.rm(path.join(config.UPLOAD_DIR, n), { force: true }, () => {});
  }
}

const HEADERS = {
  'Cache-Control': 'public, max-age=2592000, immutable',
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
};

/** Express handler for /uploads. */
function serve() {
  if (!inDb) {
    return express.static(config.UPLOAD_DIR, { maxAge: '30d', immutable: true, setHeaders: (res) => res.set(HEADERS) });
  }
  return async (req, res, next) => {
    const name = req.path.replace(/^\//, '');
    if (!SAFE_NAME.test(name)) return next();
    try {
      const row = await db.get('SELECT mime, data FROM blobs WHERE filename = ?', name);
      if (!row) return next();
      res.set({ ...HEADERS, 'Content-Type': row.mime });
      res.end(Buffer.from(row.data));
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { INCOMING_DIR, persist, remove, serve, inDb };
