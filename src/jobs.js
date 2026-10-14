const { db } = require('./db');
const config = require('./config');
const { notifyUser } = require('./notify');
const { cleanupSessions } = require('./auth');

const DAY = 86400 * 1000;

/** Expire overdue tickets and remind posters shortly before expiry. Safe to run any time. */
function runExpiry(now = Date.now()) {
  const due = db.prepare("SELECT id, user_id, type, title FROM items WHERE status = 'open' AND expires_at <= ?").all(now);
  for (const item of due) {
    db.prepare(`UPDATE items SET status = 'expired', closed_by = 'system', closed_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, item.id);
    notifyUser(item.user_id, `Your ${item.type} post "${item.title}" has expired and was closed automatically.`, `/items/${item.id}`);
  }

  const soon = db.prepare(`
    SELECT id, user_id, type, title, extensions FROM items
    WHERE status = 'open' AND reminder_sent = 0 AND expires_at <= ?
  `).all(now + config.REMINDER_DAYS_BEFORE * DAY);
  for (const item of soon) {
    db.prepare('UPDATE items SET reminder_sent = 1 WHERE id = ?').run(item.id);
    const extra = item.extensions < config.MAX_EXTENSIONS ? ' Open it to extend it if you still need it.' : '';
    notifyUser(item.user_id, `Your ${item.type} post "${item.title}" will close in ${config.REMINDER_DAYS_BEFORE} days.${extra}`, `/items/${item.id}`);
  }

  return { expired: due.length, reminded: soon.length };
}

function startJobs() {
  const tick = () => {
    try {
      runExpiry();
      cleanupSessions();
    } catch (err) {
      console.error('[jobs]', err);
    }
  };
  tick();
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = { runExpiry, startJobs };
