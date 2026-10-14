const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');
const config = require('./config');

let publicKey = null;

// VAPID keys identify this server to browser push services. Generated once, kept in the DB.
async function initPush() {
  let pub = process.env.VAPID_PUBLIC_KEY || await getSetting('vapid_public');
  let priv = process.env.VAPID_PRIVATE_KEY || await getSetting('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    await setSetting('vapid_public', pub);
    await setSetting('vapid_private', priv);
  }
  webpush.setVapidDetails(config.VAPID_SUBJECT, pub, priv);
  publicKey = pub;
}

async function sendPush(subs, payload) {
  if (!publicKey) return;
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 86400 });
    } catch (err) {
      // 404 / 410 = the browser unsubscribed; forget it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.run('DELETE FROM push_subscriptions WHERE id = ?', s.id).catch(() => {});
      } else {
        console.warn('[push] failed:', err.statusCode || err.message);
      }
    }
  }));
}

/** Personal notification: in-site bell + push to that user's devices. */
async function notifyUser(userId, text, link) {
  await db.insert('INSERT INTO notifications (user_id, text, link, created_at) VALUES (?, ?, ?, ?)',
    userId, text, link || null, Date.now());
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  sendPush(subs, { title: config.site.name, body: text, url: link || '/' }).catch(() => {});
}

/** Broadcast a new post to everyone who opted in to "all new posts" (except the poster). */
async function broadcastNewItem(item) {
  const subs = await db.all(
    "SELECT * FROM push_subscriptions WHERE scope = 'all' AND (user_id IS NULL OR user_id != ?)",
    item.user_id,
  );
  const label = item.type === 'lost' ? 'LOST' : 'FOUND';
  const where = item.location ? ` · ${item.location}` : '';
  sendPush(subs, {
    title: `${label}: ${item.title}`,
    body: `${item.category}${where}`,
    url: `/items/${item.id}`,
    image: item.photo ? `/uploads/${item.photo}` : undefined,
  }).catch(() => {});
}

module.exports = { initPush, getPublicKey: () => publicKey, notifyUser, broadcastNewItem };
