const { db } = require('./db');
const config = require('./config');
const { notifyUser } = require('./notify');
const { cleanupSessions } = require('./auth');
const storage = require('./storage');

const DAY = 86400 * 1000;

/** Expire overdue tickets and remind posters shortly before expiry. Safe to run any time. */
async function runExpiry(now = Date.now()) {
  const due = await db.all("SELECT id, user_id, type, title FROM items WHERE status = 'open' AND expires_at <= ?", now);
  for (const item of due) {
    await db.run("UPDATE items SET status = 'expired', closed_by = 'system', closed_at = ?, updated_at = ? WHERE id = ?",
      now, now, item.id);
    await notifyUser(item.user_id, `Your ${item.type} post "${item.title}" has expired and was closed automatically.`, `/items/${item.id}`);
  }

  const soon = await db.all(`
    SELECT id, user_id, type, title, extensions FROM items
    WHERE status = 'open' AND reminder_sent = 0 AND expires_at <= ?
  `, now + config.REMINDER_DAYS_BEFORE * DAY);
  for (const item of soon) {
    await db.run('UPDATE items SET reminder_sent = 1 WHERE id = ?', item.id);
    const extra = item.extensions < config.MAX_EXTENSIONS ? ' Open it to extend it if you still need it.' : '';
    await notifyUser(item.user_id, `Your ${item.type} post "${item.title}" will close in ${config.REMINDER_DAYS_BEFORE} days.${extra}`, `/items/${item.id}`);
  }

  return { expired: due.length, reminded: soon.length };
}

/** Free space: drop photos of posts that were closed long ago (the text stays). */
async function prunePhotos(now = Date.now()) {
  if (!config.PHOTO_RETENTION_DAYS) return 0;
  const cutoff = now - config.PHOTO_RETENTION_DAYS * DAY;
  const old = await db.all(`
    SELECT p.id, p.filename FROM photos p JOIN items i ON i.id = p.item_id
    WHERE i.status != 'open' AND i.closed_at IS NOT NULL AND i.closed_at < ?
  `, cutoff);
  const oldResponses = await db.all(`
    SELECT r.id, r.photo FROM responses r JOIN items i ON i.id = r.item_id
    WHERE r.photo IS NOT NULL AND i.status != 'open' AND i.closed_at IS NOT NULL AND i.closed_at < ?
  `, cutoff);
  for (const p of old) await db.run('DELETE FROM photos WHERE id = ?', p.id);
  for (const r of oldResponses) await db.run('UPDATE responses SET photo = NULL WHERE id = ?', r.id);
  await storage.remove([...old.map((p) => p.filename), ...oldResponses.map((r) => r.photo)]);
  return old.length + oldResponses.length;
}

function startJobs() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runExpiry();
      await cleanupSessions();
      await prunePhotos();
    } catch (err) {
      console.error('[jobs]', err);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = { runExpiry, prunePhotos, startJobs };
