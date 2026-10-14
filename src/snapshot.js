/**
 * Keeps the SQLite database safe on hosts without a permanent disk (Google Cloud Run):
 *   - on start-up the latest copy is downloaded from the Cloud Storage bucket,
 *   - after every change a fresh copy is uploaded (before the response is sent),
 *   - on shutdown (SIGTERM, see server.js) any pending change is uploaded.
 * Run with a single instance (Cloud Run --max-instances 1) so there is only one writer.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const gcs = require('./gcs');

const OBJECT = 'db/lostfound.db';
let db = null;
let dirty = false;
let running = null;
let lastGeneration = null;

async function restore(database) {
  const copy = await gcs.download(OBJECT);
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(database.file + ext, { force: true });
  if (copy) {
    fs.writeFileSync(database.file, copy.data);
    lastGeneration = copy.generation;
    console.log(`[snapshot] Restored database from bucket (${Math.round(copy.data.length / 1024)} KB)`);
  } else {
    console.log('[snapshot] No saved database in bucket yet; starting fresh');
  }
}

async function upload() {
  const tmp = path.join(os.tmpdir(), `jlf-snapshot-${process.pid}.db`);
  db.snapshotTo(tmp);
  const data = await fs.promises.readFile(tmp);
  fs.rm(tmp, { force: true }, () => {});
  const before = lastGeneration && await gcs.stat(OBJECT).catch(() => null);
  if (before && String(before.generation) !== String(lastGeneration)) {
    console.warn('[snapshot] Bucket copy was changed by another instance; overwriting with this one');
  }
  lastGeneration = await gcs.upload(OBJECT, data, 'application/x-sqlite3');
}

/** Upload if anything changed. Concurrent callers share one upload; a change during an upload triggers another. */
function flush() {
  if (!db) return Promise.resolve();
  if (running) return running.then(() => (dirty ? flush() : undefined));
  if (!dirty) return Promise.resolve();
  dirty = false;
  running = upload()
    .catch((err) => {
      dirty = true;
      console.error('[snapshot] Upload failed:', err.message);
      throw err;
    })
    .finally(() => { running = null; });
  return running;
}

function attach(database) {
  db = database;
  db.setOnWrite(() => { dirty = true; });
  // Safety net for writes made outside a request (expiry job etc.).
  setInterval(() => { if (dirty) flush().catch(() => {}); }, 30_000).unref();
}

/**
 * Express middleware: for requests that change data, wait until the copy is safely uploaded
 * before the response goes out (Cloud Run may pause the CPU right after responding).
 */
function middleware(req, res, next) {
  if (!db || req.method === 'GET' || req.method === 'HEAD') return next();
  const end = res.end;
  res.end = function patchedEnd(...args) {
    flush().catch(() => {}).finally(() => end.apply(res, args));
    return res;
  };
  next();
}

module.exports = { restore, attach, flush, middleware, enabled: () => !!db };
