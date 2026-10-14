const express = require('express');
const { db } = require('../db');
const { publicKey } = require('../notify');

const router = express.Router();

router.get('/push/key', (req, res) => res.json({ publicKey }));

router.post('/push/subscribe', (req, res) => {
  const sub = req.body && req.body.subscription;
  const scope = req.body && req.body.scope === 'mine' ? 'mine' : 'all';
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
      user_id = COALESCE(excluded.user_id, push_subscriptions.user_id), scope = excluded.scope
  `).run(sub.endpoint.slice(0, 1000), String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100),
    req.user?.id ?? null, scope, Date.now());
  res.json({ ok: true, scope });
});

router.post('/push/unsubscribe', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint === 'string') db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

router.post('/push/status', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  const row = typeof endpoint === 'string' && db.prepare('SELECT scope, user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  // Link the device to the account after sign-in so personal alerts reach it.
  if (row && req.user && row.user_id !== req.user.id) {
    db.prepare('UPDATE push_subscriptions SET user_id = ? WHERE endpoint = ?').run(req.user.id, endpoint);
  }
  res.json({ subscribed: !!row, scope: row ? row.scope : null });
});

module.exports = router;
