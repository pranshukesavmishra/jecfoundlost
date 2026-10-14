const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { db, getCollectionPoints, setSetting } = require('../db');
const auth = require('../auth');
const { removeFiles } = require('../upload');
const { notifyUser } = require('../notify');
const { runExpiry } = require('../jobs');
const { clean, DAY } = require('../helpers');

const router = express.Router();
router.use(auth.requireLogin, auth.requireAdmin);

const STATUSES = ['open', 'resolved', 'closed', 'expired'];

router.get('/', (req, res) => {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(status = 'open') AS open,
      SUM(status = 'resolved') AS resolved,
      SUM(status = 'expired') AS expired,
      SUM(status = 'closed') AS closed,
      SUM(type = 'lost') AS lost,
      SUM(type = 'found') AS found,
      SUM(created_at > ?) AS last7
    FROM items
  `).get(Date.now() - 7 * DAY);
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const subscribers = db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n;

  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const q = String(req.query.q || '').slice(0, 100);
  const where = [];
  const params = [];
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (q) { where.push('(i.title LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const items = db.prepare(`
    SELECT i.*, u.name AS poster_name, u.phone AS poster_phone,
      (SELECT filename FROM photos p WHERE p.item_id = i.id ORDER BY p.id LIMIT 1) AS photo,
      (SELECT COUNT(*) FROM responses r WHERE r.item_id = i.id) AS response_count
    FROM items i JOIN users u ON u.id = i.user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.created_at DESC LIMIT 200
  `).all(...params);

  res.render('admin/index', { title: 'Admin', counts, users, subscribers, items, status, q });
});

router.post('/items/:id/:action', (req, res, next) => {
  const id = Number(req.params.id);
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) return next();
  const now = Date.now();
  const back = req.body.back === 'item' ? `/items/${id}` : '/admin';
  switch (req.params.action) {
    case 'reopen': {
      const days = item.type === 'lost' ? config.LOST_EXPIRY_DAYS : config.FOUND_EXPIRY_DAYS;
      db.prepare(`UPDATE items SET status = 'open', closed_by = NULL, closed_at = NULL, close_note = NULL,
                  reminder_sent = 0, expires_at = ?, updated_at = ? WHERE id = ?`).run(Math.max(item.expires_at, now + days * DAY), now, id);
      notifyUser(item.user_id, `An admin reopened your post "${item.title}".`, `/items/${id}`);
      res.flash('Post reopened.');
      break;
    }
    case 'close':
      if (item.status === 'open') {
        db.prepare(`UPDATE items SET status = 'closed', closed_by = 'admin', close_note = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
          .run(clean(req.body.note, 300) || null, now, now, id);
        notifyUser(item.user_id, `An admin closed your post "${item.title}".`, `/items/${id}`);
      }
      res.flash('Post closed.');
      break;
    case 'delete': {
      const files = [
        ...db.prepare('SELECT filename FROM photos WHERE item_id = ?').all(id).map((p) => p.filename),
        ...db.prepare('SELECT photo FROM responses WHERE item_id = ? AND photo IS NOT NULL').all(id).map((r) => r.photo),
      ];
      db.prepare('DELETE FROM items WHERE id = ?').run(id);
      removeFiles(files);
      res.flash('Post deleted permanently.');
      return res.redirect('/admin');
    }
    default:
      return next();
  }
  res.redirect(back);
});

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').slice(0, 100);
  const users = db.prepare(`
    SELECT u.id, u.name, u.phone, u.email, u.college_id, u.department, u.role, u.is_banned, u.created_at,
      (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS item_count
    FROM users u
    ${q ? 'WHERE u.name LIKE ? OR u.phone LIKE ? OR u.college_id LIKE ?' : ''}
    ORDER BY u.created_at DESC LIMIT 300
  `).all(...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
  res.render('admin/users', { title: 'Users', users, q, tempPassword: null });
});

router.post('/users/:id/:action', (req, res, next) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return next();
  if (target.id === req.user.id && req.params.action !== 'reset') {
    res.flash('You cannot change your own role or ban yourself.');
    return res.redirect('/admin/users');
  }
  switch (req.params.action) {
    case 'ban':
      db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      res.flash(`${target.name} is blocked and their open posts were closed.`);
      db.prepare(`UPDATE items SET status = 'closed', closed_by = 'admin', closed_at = ?, updated_at = ? WHERE user_id = ? AND status = 'open'`)
        .run(Date.now(), Date.now(), id);
      break;
    case 'unban':
      db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(id);
      res.flash(`${target.name} is unblocked.`);
      break;
    case 'promote':
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
      res.flash(`${target.name} is now an admin.`);
      break;
    case 'demote':
      db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(id);
      res.flash(`${target.name} is no longer an admin.`);
      break;
    case 'reset': {
      // Readable temporary password the admin can tell the student in person / by phone.
      const temp = `jec${crypto.randomInt(100000, 1000000)}`;
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(temp), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      res.flash(`Temporary password for ${target.name} (${target.phone}): ${temp} — ask them to change it from My profile.`);
      break;
    }
    default:
      return next();
  }
  res.redirect('/admin/users');
});

router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Settings', points: getCollectionPoints() });
});

router.post('/settings', (req, res) => {
  const points = String(req.body.points || '').split('\n').map((p) => clean(p, 80)).filter(Boolean).slice(0, 20);
  setSetting('collection_points', JSON.stringify(points));
  res.flash('Collection points saved.');
  res.redirect('/admin/settings');
});

router.post('/run-expiry', (req, res) => {
  const r = runExpiry();
  res.flash(`Expiry check done: ${r.expired} expired, ${r.reminded} reminders sent.`);
  res.redirect('/admin');
});

module.exports = router;
