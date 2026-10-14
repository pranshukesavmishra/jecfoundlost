/**
 * Photo storage. Photos are always referenced as /uploads/<filename>.
 *   gcs:  GCS_BUCKET is set (Google Cloud Run) -> objects photos/<filename> in the bucket
 *   db:   DATABASE_URL is set (Render + Supabase) -> bytes in the `blobs` table
 *   disk: otherwise -> files in DATA_DIR/uploads
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const config = require('./config');
const { db } = require('./db');
const gcs = require('./gcs');

const MODE = config.GCS_BUCKET ? 'gcs' : config.DATABASE_URL ? 'db' : 'disk';
// Where multer writes incoming files before they are stored.
const INCOMING_DIR = MODE === 'disk' ? config.UPLOAD_DIR : path.join(os.tmpdir(), 'jlf-incoming');
fs.mkdirSync(INCOMING_DIR, { recursive: true });

const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const SAFE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/;

/** Move freshly uploaded multer files into permanent storage. */
async function persist(files) {
  if (MODE === 'disk') return;
  for (const f of files) {
    const data = await fs.promises.readFile(f.path);
    const mime = MIME[path.extname(f.filename)] || 'application/octet-stream';
    if (MODE === 'gcs') {
      await gcs.upload(`photos/${f.filename}`, data, mime);
    } else {
      await db.run('INSERT INTO blobs (filename, mime, data, created_at) VALUES (?, ?, ?, ?)', f.filename, mime, data, Date.now());
    }
    fs.rm(f.path, { force: true }, () => {});
  }
}

/** Delete stored photos by filename. */
async function remove(filenames) {
  const names = (filenames || []).filter(Boolean).map((n) => path.basename(n));
  if (!names.length) return;
  if (MODE === 'gcs') {
    for (const n of names) {
      if (memory.has(n)) { memoryBytes -= memory.get(n).data.length; memory.delete(n); }
      await gcs.remove(`photos/${n}`).catch((err) => console.warn('[storage]', err.message));
    }
  } else if (MODE === 'db') {
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

// Small in-memory cache so popular photos aren't fetched from the bucket every time.
const memory = new Map();
const MEMORY_LIMIT = 48 * 1024 * 1024;
let memoryBytes = 0;
function remember(name, entry) {
  memory.set(name, entry);
  memoryBytes += entry.data.length;
  for (const [k, v] of memory) {
    if (memoryBytes <= MEMORY_LIMIT) break;
    memory.delete(k);
    memoryBytes -= v.data.length;
  }
}

async function load(name) {
  if (MODE === 'gcs') {
    const hit = memory.get(name);
    if (hit) return hit;
    const obj = await gcs.download(`photos/${name}`);
    if (!obj) return null;
    const entry = { mime: MIME[path.extname(name)] || obj.contentType, data: obj.data };
    remember(name, entry);
    return entry;
  }
  const row = await db.get('SELECT mime, data FROM blobs WHERE filename = ?', name);
  return row ? { mime: row.mime, data: Buffer.from(row.data) } : null;
}

/** Express handler for /uploads. */
function serve() {
  if (MODE === 'disk') {
    return express.static(config.UPLOAD_DIR, { maxAge: '30d', immutable: true, setHeaders: (res) => res.set(HEADERS) });
  }
  return async (req, res, next) => {
    const name = req.path.replace(/^\//, '');
    if (!SAFE_NAME.test(name)) return next();
    try {
      const file = await load(name);
      if (!file) return next();
      res.set({ ...HEADERS, 'Content-Type': file.mime });
      res.end(file.data);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { INCOMING_DIR, MODE, persist, remove, serve };
