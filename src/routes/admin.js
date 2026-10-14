const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { db, getCollectionPoints, setSetting, getTheme } = require('../db');
const auth = require('../auth');
const storage = require('../storage');
const { notifyUser } = require('../notify');
const { runExpiry } = require('../jobs');
const { countIf, likeTerm } = require('../items');
const { clean, DAY } = require('../helpers');

const router = express.Router();
router.use(auth.requireLogin, auth.requireAdmin);

const STATUSES = ['open', 'resolved', 'closed', 'expired'];

router.get('/', async (req, res) => {
  const counts = await db.get(`
    SELECT
      COUNT(*) AS total,
      ${countIf("status = 'open'")} AS open,
      ${countIf("status = 'resolved'")} AS resolved,
      ${countIf("status = 'expired'")} AS expired,
      ${countIf("status = 'closed'")} AS closed,
      ${countIf('created_at > ?')} AS last7
    FROM items
  `, Date.now() - 7 * DAY);
  const users = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  const subscribers = (await db.get('SELECT COUNT(*) AS n FROM push_subscriptions')).n;

  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').slice(0, 100);
  const where = [];
  const params = [];
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (q.trim()) {
    const like = likeTerm(q);
    where.push("(LOWER(i.title) LIKE ? ESCAPE '\\' OR LOWER(u.name) LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const items = await db.all(`
    SELECT i.*, u.name AS poster_name, u.phone AS poster_phone,
      (SELECT filename FROM photos p WHERE p.item_id = i.id ORDER BY p.id LIMIT 1) AS photo,
      (SELECT COUNT(*) FROM responses r WHERE r.item_id = i.id) AS response_count
    FROM items i JOIN users u ON u.id = i.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.created_at DESC LIMIT 200
  `, ...params);

  res.render('admin/index', { title: 'Admin', counts, users, subscribers, items, status, q });
});

router.post('/items/:id/:action', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const id = Number(req.params.id);
  const item = await db.get('SELECT * FROM items WHERE id = ?', id);
  if (!item) return next();
  const now = Date.now();
  const back = req.body.back === 'item' ? `/items/${id}` : '/admin';
  switch (req.params.action) {
    case 'reopen': {
      const days = item.type === 'lost' ? config.LOST_EXPIRY_DAYS : config.FOUND_EXPIRY_DAYS;
      await db.run(`UPDATE items SET status = 'open', closed_by = NULL, closed_at = NULL, close_note = NULL,
                    reminder_sent = 0, expires_at = ?, updated_at = ? WHERE id = ?`, Math.max(item.expires_at, now + days * DAY), now, id);
      await notifyUser(item.user_id, `An admin reopened your post "${item.title}".`, `/items/${id}`);
      res.flash('Post reopened.');
      break;
    }
    case 'close':
      if (item.status === 'open') {
        await db.run("UPDATE items SET status = 'closed', closed_by = 'admin', close_note = ?, closed_at = ?, updated_at = ? WHERE id = ?",
          clean(req.body.note, 300) || null, now, now, id);
        await notifyUser(item.user_id, `An admin closed your post "${item.title}".`, `/items/${id}`);
      }
      res.flash('Post closed.');
      break;
    case 'delete': {
      const files = [
        ...(await db.all('SELECT filename FROM photos WHERE item_id = ?', id)).map((p) => p.filename),
        ...(await db.all('SELECT photo FROM responses WHERE item_id = ? AND photo IS NOT NULL', id)).map((r) => r.photo),
      ];
      await db.run('DELETE FROM items WHERE id = ?', id);
      await storage.remove(files);
      res.flash('Post deleted permanently.');
      return res.redirect('/admin');
    }
    default:
      return next();
  }
  res.redirect(back);
});

router.get('/users', async (req, res) => {
  const q = String(req.query.q || '').slice(0, 100).trim();
  const like = q ? likeTerm(q) : null;
  const users = await db.all(`
    SELECT u.id, u.name, u.phone, u.email, u.college_id, u.department, u.role, u.is_banned, u.created_at,
      (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS item_count
    FROM users u
    ${q ? "WHERE LOWER(u.name) LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\' OR LOWER(u.college_id) LIKE ? ESCAPE '\\'" : ''}
    ORDER BY u.created_at DESC LIMIT 300
  `, ...(q ? [like, like, like] : []));
  res.render('admin/users', { title: 'Users', users, q });
});

router.post('/users/:id/:action', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const id = Number(req.params.id);
  const target = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) return next();
  if (target.id === req.user.id && req.params.action !== 'reset') {
    res.flash('You cannot change your own role or ban yourself.');
    return res.redirect('/admin/users');
  }
  switch (req.params.action) {
    case 'ban':
      await db.run('UPDATE users SET is_banned = 1 WHERE id = ?', id);
      await db.run('DELETE FROM sessions WHERE user_id = ?', id);
      await db.run("UPDATE items SET status = 'closed', closed_by = 'admin', closed_at = ?, updated_at = ? WHERE user_id = ? AND status = 'open'",
        Date.now(), Date.now(), id);
      res.flash(`${target.name} is blocked and their open posts were closed.`);
      break;
    case 'unban':
      await db.run('UPDATE users SET is_banned = 0 WHERE id = ?', id);
      res.flash(`${target.name} is unblocked.`);
      break;
    case 'promote':
      await db.run("UPDATE users SET role = 'admin' WHERE id = ?", id);
      res.flash(`${target.name} is now an admin.`);
      break;
    case 'demote':
      await db.run("UPDATE users SET role = 'user' WHERE id = ?", id);
      res.flash(`${target.name} is no longer an admin.`);
      break;
    case 'reset': {
      // Readable temporary password the admin can tell the student in person / by phone.
      const temp = `jec${crypto.randomInt(100000, 1000000)}`;
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(temp), id);
      await db.run('DELETE FROM sessions WHERE user_id = ?', id);
      res.flash(`Temporary password for ${target.name} (${target.phone}): ${temp} — ask them to change it from My profile.`);
      break;
    }
    default:
      return next();
  }
  res.redirect('/admin/users');
});

router.get('/settings', async (req, res) => {
  res.render('admin/settings', { title: 'Settings', points: await getCollectionPoints(), currentTheme: await getTheme() });
});

router.post('/settings', async (req, res) => {
  const points = String(req.body.points || '').split('\n').map((p) => clean(p, 80)).filter(Boolean).slice(0, 20);
  await setSetting('collection_points', JSON.stringify(points));
  res.flash('Collection points saved.');
  res.redirect('/admin/settings');
});

router.post('/theme', async (req, res) => {
  const theme = config.themes.find((t) => t.id === req.body.theme);
  if (theme) {
    await setSetting('theme', theme.id);
    res.flash(`Theme changed to ${theme.name}. Everyone sees it now.`);
  }
  res.redirect('/admin/settings');
});

router.post('/run-expiry', async (req, res) => {
  const r = await runExpiry();
  res.flash(`Expiry check done: ${r.expired} expired, ${r.reminded} reminders sent.`);
  res.redirect('/admin');
});

module.exports = router;
