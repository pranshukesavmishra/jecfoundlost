const express = require('express');
const config = require('../config');
const { db, getCollectionPoints } = require('../db');
const auth = require('../auth');
const storage = require('../storage');
const { photos, removeFiles } = require('../upload');
const { notifyUser, broadcastNewItem } = require('../notify');
const { getItem } = require('../items');
const { clean, todayIST, DAY, shortName } = require('../helpers');

const router = express.Router();

/** CSRF check for multipart forms; deletes already-saved photos if the token is bad. */
function csrfAfterUpload(req, res, next) {
  let ok = false;
  auth.checkCsrf(req, res, () => { ok = true; });
  if (ok) return next();
  removeFiles(req.files || (req.file ? [req.file] : []));
}

const wantsJson = (req) => req.get('accept')?.includes('application/json');

/** Redirect for normal forms, JSON for the photo-compressing fetch() submit. */
function done(req, res, url, msg) {
  if (msg) res.flash(msg);
  if (wantsJson(req)) return res.json({ redirect: url });
  res.redirect(url);
}

async function loadItem(req, res, next) {
  if (!/^\d+$/.test(req.params.id)) return next('route');
  const item = await getItem(Number(req.params.id));
  if (!item) {
    removeFiles(req.files || (req.file ? [req.file] : []));
    return res.status(404).render('error', { title: 'Not found', message: 'This post does not exist any more.' });
  }
  req.item = item;
  req.isOwner = item.user_id === req.user.id;
  req.isAdmin = req.user.role === 'admin';
  next();
}

function ownerOrAdmin(req, res, next) {
  if (req.isOwner || req.isAdmin) return next();
  res.status(403).render('error', { title: 'Not allowed', message: 'Only the person who posted this (or an admin) can do that.' });
}

// ---------- Report lost / found ----------

async function renderReport(res, type, form, error, status = 200) {
  res.status(status).render('report', {
    title: type === 'lost' ? 'Report a lost item' : 'Report a found item',
    type,
    form,
    error,
    today: todayIST(),
    collectionPoints: await getCollectionPoints(),
  });
}

router.get('/report/:type', auth.requireLogin, async (req, res, next) => {
  const { type } = req.params;
  if (type !== 'lost' && type !== 'found') return next();
  await renderReport(res, type, { event_date: todayIST(), handover: 'me' }, null);
});

router.post('/report/:type', auth.requireLogin, photos('photos', config.MAX_PHOTOS), csrfAfterUpload, async (req, res, next) => {
  const { type } = req.params;
  const files = req.files || [];
  if (type !== 'lost' && type !== 'found') {
    removeFiles(files);
    return next();
  }
  const points = await getCollectionPoints();
  const form = {
    title: clean(req.body.title, 80),
    category: config.categories.includes(req.body.category) ? req.body.category : '',
    description: clean(req.body.description, 1500),
    location: clean(req.body.location, 120),
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(req.body.event_date || '') ? req.body.event_date : '',
    handover: type === 'found' ? (req.body.handover === 'me' || points.includes(req.body.handover) ? req.body.handover : 'me') : null,
    secret_detail: type === 'found' ? clean(req.body.secret_detail, 300) : '',
  };
  const fail = (msg) => {
    removeFiles(files);
    if (wantsJson(req)) return res.status(400).json({ error: msg });
    return renderReport(res, type, form, msg, 400);
  };

  if (req.uploadError) return fail(req.uploadError);
  if (form.title.length < 3) return fail('Please give a short title, e.g. "Black HP calculator".');
  if (!form.category) return fail('Please choose a category.');
  if (!form.location) return fail(type === 'lost' ? 'Where did you lose it (roughly)?' : 'Where did you find it?');
  if (form.event_date && form.event_date > todayIST()) return fail('The date cannot be in the future.');

  const recent = (await db.get('SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND created_at > ?', req.user.id, Date.now() - DAY)).n;
  if (recent >= config.MAX_POSTS_PER_DAY && req.user.role !== 'admin') return fail('You have posted a lot today. Please try again tomorrow.');

  try {
    await storage.persist(files);
  } catch (err) {
    console.error('[upload]', err);
    return fail('Could not save the photos. Please try again.');
  }

  const now = Date.now();
  const days = type === 'lost' ? config.LOST_EXPIRY_DAYS : config.FOUND_EXPIRY_DAYS;
  const id = await db.tx(async (t) => {
    const itemId = await t.insert(`
      INSERT INTO items (type, title, category, description, location, event_date, secret_detail, handover,
                         user_id, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, type, form.title, form.category, form.description, form.location, form.event_date || null,
    form.secret_detail || null, form.handover, req.user.id, now, now, now + days * DAY);
    for (const f of files) await t.insert('INSERT INTO photos (item_id, filename) VALUES (?, ?)', itemId, f.filename);
    return itemId;
  });

  broadcastNewItem({ id, type, title: form.title, category: form.category, location: form.location, user_id: req.user.id, photo: files[0]?.filename })
    .catch((err) => console.warn('[push]', err.message));
  done(req, res, `/items/${id}`, 'Posted! Everyone with notifications on has been alerted. Share it on WhatsApp groups too.');
});

// ---------- Responses: "I found this" / "This is mine" ----------

router.post('/items/:id/respond', auth.requireLogin, photos('photo', 1), csrfAfterUpload, loadItem, async (req, res) => {
  const { item } = req;
  const files = req.file ? [req.file] : [];
  const back = `/items/${item.id}`;
  const fail = (msg) => {
    removeFiles(files);
    if (wantsJson(req)) return res.status(400).json({ error: msg });
    res.flash(msg);
    res.redirect(back);
  };
  if (req.uploadError) return fail(req.uploadError);
  if (req.isOwner) return fail('This is your own post.');
  if (item.status !== 'open') return fail('This post is no longer open.');
  const existing = await db.get("SELECT 1 AS x FROM responses WHERE item_id = ? AND user_id = ? AND status != 'withdrawn'", item.id, req.user.id);
  if (existing) return fail('You have already responded to this post.');
  const message = clean(req.body.message, 1000);
  if (message.length < 5) return fail(item.type === 'lost' ? 'Please tell the owner where/when you found it.' : 'Please describe the item so the finder knows it is yours.');

  try {
    await storage.persist(files);
  } catch (err) {
    console.error('[upload]', err);
    return fail('Could not save the photo. Please try again.');
  }
  await db.insert('INSERT INTO responses (item_id, user_id, message, photo, created_at) VALUES (?, ?, ?, ?, ?)',
    item.id, req.user.id, message, req.file?.filename || null, Date.now());

  const who = shortName(req.user.name);
  await notifyUser(item.user_id, item.type === 'lost'
    ? `${who} says they found your "${item.title}". Open it to confirm and get their number.`
    : `${who} says the "${item.title}" you found belongs to them. Check their proof.`, back);
  done(req, res, back, 'Sent! You will be notified (and get their contact) once they confirm.');
});

async function loadResponse(req, res, next) {
  if (!/^\d+$/.test(req.params.rid)) return next('route');
  const r = await db.get('SELECT * FROM responses WHERE id = ?', Number(req.params.rid));
  if (!r) return res.status(404).render('error', { title: 'Not found', message: 'That response no longer exists.' });
  req.params.id = String(r.item_id);
  req.response = r;
  return loadItem(req, res, next);
}

router.post('/responses/:rid/:action', auth.requireLogin, loadResponse, async (req, res, next) => {
  const { item, response: r } = req;
  const { action } = req.params;
  const back = `/items/${item.id}`;
  const now = Date.now();

  if (action === 'accept' || action === 'reject') {
    if (!req.isOwner) return res.status(403).render('error', { title: 'Not allowed', message: 'Only the person who posted this can do that.' });
    if (r.status !== 'pending') return done(req, res, back, 'That response was already handled.');
    if (action === 'accept') {
      await db.run("UPDATE responses SET status = 'accepted', decided_at = ? WHERE id = ?", now, r.id);
      const owner = await db.get('SELECT name, phone FROM users WHERE id = ?', item.user_id);
      await notifyUser(r.user_id, `${shortName(owner.name)} confirmed the match for "${item.title}". Their number is ${owner.phone}. Open the post to call or WhatsApp.`, back);
      return done(req, res, back, 'Confirmed! You can now see each other\'s number. Mark the post as returned once you have it.');
    }
    await db.run("UPDATE responses SET status = 'rejected', decided_at = ? WHERE id = ?", now, r.id);
    await notifyUser(r.user_id, `Your response to "${item.title}" was declined by the poster.`, back);
    return done(req, res, back, 'Response declined.');
  }

  if (action === 'withdraw') {
    if (r.user_id !== req.user.id) return res.status(403).render('error', { title: 'Not allowed', message: 'You can only withdraw your own response.' });
    await db.run("UPDATE responses SET status = 'withdrawn', decided_at = ? WHERE id = ?", now, r.id);
    return done(req, res, back, 'Response withdrawn.');
  }
  next();
});

// ---------- Close / resolve / extend ----------

router.post('/items/:id/resolve', auth.requireLogin, loadItem, ownerOrAdmin, async (req, res) => {
  const { item } = req;
  if (item.status !== 'open') return done(req, res, `/items/${item.id}`, 'This post is already closed.');
  const now = Date.now();
  await db.run("UPDATE items SET status = 'resolved', close_note = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?",
    clean(req.body.note, 300) || null, req.isOwner ? 'owner' : 'admin', now, now, item.id);
  for (const r of await db.all("SELECT user_id FROM responses WHERE item_id = ? AND status = 'accepted'", item.id)) {
    await notifyUser(r.user_id, `"${item.title}" was marked as returned. Thank you for helping!`, `/items/${item.id}`);
  }
  done(req, res, `/items/${item.id}`, 'Marked as returned. Great news!');
});

router.post('/items/:id/close', auth.requireLogin, loadItem, ownerOrAdmin, async (req, res) => {
  const { item } = req;
  if (item.status !== 'open') return done(req, res, `/items/${item.id}`, 'This post is already closed.');
  const now = Date.now();
  await db.run("UPDATE items SET status = 'closed', close_note = ?, closed_by = ?, closed_at = ?, updated_at = ? WHERE id = ?",
    clean(req.body.note, 300) || null, req.isOwner ? 'owner' : 'admin', now, now, item.id);
  if (!req.isOwner) await notifyUser(item.user_id, `An admin closed your post "${item.title}".`, `/items/${item.id}`);
  done(req, res, `/items/${item.id}`, 'Post closed.');
});

router.post('/items/:id/extend', auth.requireLogin, loadItem, async (req, res) => {
  const { item } = req;
  const back = `/items/${item.id}`;
  if (!req.isOwner) return res.status(403).render('error', { title: 'Not allowed', message: 'Only the person who posted this can extend it.' });
  if (item.status !== 'open' && item.status !== 'expired') return done(req, res, back, 'Only open or expired posts can be extended.');
  if (item.extensions >= config.MAX_EXTENSIONS) return done(req, res, back, `A post can be extended at most ${config.MAX_EXTENSIONS} times. Please create a new post if needed.`);
  const now = Date.now();
  const days = item.type === 'lost' ? config.LOST_EXPIRY_DAYS : config.FOUND_EXPIRY_DAYS;
  await db.run(`UPDATE items SET status = 'open', expires_at = ?, extensions = extensions + 1, reminder_sent = 0,
                closed_by = NULL, closed_at = NULL, updated_at = ? WHERE id = ?`,
  Math.max(item.expires_at, now) + days * DAY, now, item.id);
  done(req, res, back, `Extended by ${days} days.`);
});

module.exports = router;
