const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');
const config = require('./config');

// VAPID keys identify this server to browser push services. Generated once, kept in the DB.
function vapidKeys() {
  let pub = process.env.VAPID_PUBLIC_KEY || getSetting('vapid_public');
  let priv = process.env.VAPID_PRIVATE_KEY || getSetting('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setSetting('vapid_public', pub);
    setSetting('vapid_private', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

const keys = vapidKeys();
webpush.setVapidDetails(config.VAPID_SUBJECT, keys.publicKey, keys.privateKey);

async function sendPush(subs, payload) {
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400 });
    } catch (err) {
      // 404 / 410 = the browser unsubscribed; forget it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      } else {
        console.warn('[push] failed:', err.statusCode || err.message);
      }
    }
  }));
}

/** Personal notification: in-site bell + push to that user's devices. */
function notifyUser(userId, text, link) {
  db.prepare('INSERT INTO notifications (user_id, text, link, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, text, link || null, Date.now());
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  sendPush(subs, { title: config.site.name, body: text, url: link || '/' }).catch(() => {});
}

/** Broadcast a new post to everyone who opted in to "all new posts" (except the poster). */
function broadcastNewItem(item) {
  const subs = db.prepare(
    "SELECT * FROM push_subscriptions WHERE scope = 'all' AND (user_id IS NULL OR user_id != ?)",
  ).all(item.user_id);
  const label = item.type === 'lost' ? 'LOST' : 'FOUND';
  const where = item.location ? ` · ${item.location}` : '';
  sendPush(subs, {
    title: `${label}: ${item.title}`,
    body: `${item.category}${where}`,
    url: `/items/${item.id}`,
    image: item.photo ? `/uploads/${item.photo}` : undefined,
  }).catch(() => {});
}

module.exports = { publicKey: keys.publicKey, notifyUser, broadcastNewItem };
