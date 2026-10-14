const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jlf-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PHONE = '9000000001';
process.env.ADMIN_PASSWORD = 'adminpass';
// Run the same suite against Postgres with: TEST_DATABASE_URL=postgres://… npm test
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let app;
let runExpiry;
let prunePhotos;
let db;

let server;
let base;

// 1x1 JPEG
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

/** Minimal browser: keeps cookies, reads the CSRF token from pages. */
function client() {
  const jar = new Map();
  let csrf = null;
  async function req(method, url, { form, multipart, json } = {}) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ _csrf: csrf, ...form }).toString();
    } else if (multipart) {
      body = new FormData();
      body.append('_csrf', csrf);
      for (const [k, v] of Object.entries(multipart)) {
        if (Buffer.isBuffer(v)) body.append(k, new Blob([v], { type: 'image/jpeg' }), 'p.jpg');
        else body.append(k, v);
      }
      headers.accept = 'application/json';
    } else if (json) {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrf;
      headers.accept = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v === '' || /Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([a-f0-9]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text };
  }
  return {
    get: (u) => req('GET', u),
    post: (u, opts) => req('POST', u, opts),
  };
}

async function register(c, name, phone) {
  await c.get('/register');
  const r = await c.post('/register', { form: { name, phone, college_id: `0201ME${phone.slice(-3)}`, department: 'Mechatronics Engineering', password: 'secret12', password2: 'secret12', next: '/' } });
  assert.equal(r.status, 302, r.text);
  await c.get('/');
}

before(async () => {
  if (process.env.DATABASE_URL) {
    // Start from an empty database.
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
  }
  app = require('../src/server');
  ({ runExpiry, prunePhotos } = require('../src/jobs'));
  ({ db } = require('../src/db'));
  await app.init();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('lost item: post, respond, confirm, phone sharing, resolve', async () => {
  const owner = client();
  const finder = client();
  const visitor = client();
  await register(owner, 'Riya Verma', '9811111111');
  await register(finder, 'Aman Gupta', '9822222222');

  // Post with photo (JSON flow used by the browser script)
  const post = await owner.post('/report/lost', { multipart: { title: 'Blue Casio calculator', category: 'Calculator', location: 'Central Library', description: 'Name written inside', photos: JPEG } });
  assert.equal(post.status, 200, post.text);
  const { redirect } = JSON.parse(post.text);
  assert.match(redirect, /^\/items\/\d+$/);
  const id = redirect.split('/').pop();

  // Public listing + detail never expose the phone number
  const home = await visitor.get('/');
  assert.match(home.text, /Blue Casio calculator/);
  const pub = await visitor.get(redirect);
  assert.match(pub.text, /Riya V\./);
  assert.doesNotMatch(pub.text, /9811111111/);
  assert.match(pub.text, /Sign in to respond/);

  // Owner can't respond to own post
  const self = await owner.post(`${redirect}/respond`, { multipart: { message: 'test my own' } });
  assert.match(self.text, /your own post/);

  // Finder responds
  await finder.get(redirect);
  const resp = await finder.post(`${redirect}/respond`, { multipart: { message: 'Found it on the 2nd floor, have it with me', photo: JPEG } });
  assert.equal(resp.status, 200, resp.text);
  const again = await finder.post(`${redirect}/respond`, { multipart: { message: 'Second response attempt' } });
  assert.match(again.text, /already responded/);

  // Owner got a notification; finder's number still hidden from owner until confirmed
  const notes = await owner.get('/me/notifications');
  assert.match(notes.text, /says they found your/);
  let ownerView = await owner.get(redirect);
  assert.doesNotMatch(ownerView.text, /9822222222/);
  const rid = ownerView.text.match(/\/responses\/(\d+)\/accept/)[1];

  // Finder cannot accept their own response
  const sneaky = await finder.post(`/responses/${rid}/accept`, { form: {} });
  assert.equal(sneaky.status, 403);

  // Owner confirms -> both see each other's number
  const acc = await owner.post(`/responses/${rid}/accept`, { form: {} });
  assert.equal(acc.status, 302);
  ownerView = await owner.get(redirect);
  assert.match(ownerView.text, /9822222222/);
  const finderView = await finder.get(redirect);
  assert.match(finderView.text, /9811111111/);
  assert.match(finderView.text, /wa\.me\/919811111111/);
  // Still private for everyone else
  assert.doesNotMatch((await visitor.get(redirect)).text, /98(11111111|22222222)/);

  // Resolve
  const res = await owner.post(`${redirect}/resolve`, { form: { note: 'Thanks Aman!' } });
  assert.equal(res.status, 302);
  const after = await visitor.get(redirect);
  assert.match(after.text, /Returned to its owner/);
  assert.equal((await db.get('SELECT status FROM items WHERE id = ?', id)).status, 'resolved');
  assert.match((await finder.get('/me/notifications')).text, /marked as returned/);
});

test('found item: secret detail only for finder/admin, handover point', async () => {
  const finder = client();
  const other = client();
  await register(finder, 'Neha Singh', '9833333333');
  await register(other, 'Rohit Jain', '9844444444');
  const r = await finder.post('/report/found', { multipart: { title: 'Black wallet', category: 'Wallet / Purse', location: 'Canteen', handover: 'Mechatronics Department Office', secret_detail: 'Has 200 rupees and a metro card' } });
  const url = JSON.parse(r.text).redirect;
  assert.match((await finder.get(url)).text, /metro card/);
  const seen = await other.get(url);
  assert.doesNotMatch(seen.text, /metro card/);
  assert.match(seen.text, /Deposited at Mechatronics Department Office/);
  assert.match(seen.text, /This is mine/);
});

test('validation, CSRF and access control', async () => {
  const c = client();
  await register(c, 'Test User', '9855555555');
  // missing category
  const bad = await c.post('/report/lost', { multipart: { title: 'Keys', location: 'Gate' } });
  assert.equal(bad.status, 400);
  // not an image
  const notImg = await c.post('/report/lost', { multipart: { title: 'Keys', category: 'Keys', location: 'Gate', photos: Buffer.from('<html>hi</html>') } });
  assert.match(notImg.text, /not a valid image/);
  // bad CSRF token
  const res = await fetch(`${base}/report/lost`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=nope&title=x', redirect: 'manual' });
  assert.equal(res.status, 403);
  // admin pages
  assert.equal((await c.get('/admin')).status, 403);
  // duplicate phone
  const dup = client();
  await dup.get('/register');
  const d = await dup.post('/register', { form: { name: 'Dup', phone: '+91 98555 55555', college_id: 'x', department: 'Other', password: 'secret12', password2: 'secret12' } });
  assert.match(d.text, /already exists/);
});

test('expiry: reminder, auto-close, extend, admin actions', async () => {
  const c = client();
  await register(c, 'Expiry Tester', '9866666666');
  const r = await c.post('/report/lost', { multipart: { title: 'Red umbrella', category: 'Other', location: 'Bus stop' } });
  const url = JSON.parse(r.text).redirect;
  const id = Number(url.split('/').pop());
  const DAY = 86400000;

  // 1 day before expiry -> reminder
  await db.run('UPDATE items SET expires_at = ? WHERE id = ?', Date.now() + DAY, id);
  await runExpiry();
  assert.match((await c.get('/me/notifications')).text, /will close in/);

  // past expiry -> expired
  await db.run('UPDATE items SET expires_at = ? WHERE id = ?', Date.now() - 1000, id);
  await runExpiry();
  assert.equal((await db.get('SELECT status FROM items WHERE id = ?', id)).status, 'expired');
  await c.get(url);

  // owner reopens with an extension
  await c.post(`${url}/extend`, { form: {} });
  const row = (await db.get('SELECT status, extensions, expires_at FROM items WHERE id = ?', id));
  assert.equal(row.status, 'open');
  assert.equal(row.extensions, 1);
  assert.ok(row.expires_at > Date.now() + 14 * DAY);

  // admin closes, then deletes
  const admin = client();
  await admin.get('/login');
  const li = await admin.post('/login', { form: { phone: '9000000001', password: 'adminpass', next: '/admin' } });
  assert.equal(li.location, '/admin');
  const dash = await admin.get('/admin');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Red umbrella/);
  await admin.post(`/admin/items/${id}/close`, { form: {} });
  assert.equal((await db.get('SELECT status FROM items WHERE id = ?', id)).status, 'closed');
  await admin.get('/admin');
  await admin.post(`/admin/items/${id}/delete`, { form: {} });
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM items WHERE id = ?', id)).n, 0);

  // admin blocks user -> user is signed out
  const uid = (await db.get("SELECT id FROM users WHERE phone = '9866666666'")).id;
  await admin.get('/admin/users');
  await admin.post(`/admin/users/${uid}/ban`, { form: {} });
  assert.equal((await c.get('/me')).status, 302);
});

test('push subscription endpoints', async () => {
  const c = client();
  await c.get('/');
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'BFakeKey', auth: 'fakeauth' } };
  const r = await c.post('/push/subscribe', { json: { subscription: sub, scope: 'all' } });
  assert.match(r.text, /"ok":true/);
  const s = await c.post('/push/status', { json: { endpoint: sub.endpoint } });
  assert.match(s.text, /"subscribed":true/);
  await c.post('/push/unsubscribe', { json: { endpoint: sub.endpoint } });
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM push_subscriptions')).n, 0);
});

test('photos are stored, served and cleaned up', async () => {
  const c = client();
  await register(c, 'Photo Tester', '9877777777');
  const r = await c.post('/report/found', { multipart: { title: 'Blue umbrella', category: 'Other', location: 'Library', photos: JPEG } });
  const url = JSON.parse(r.text).redirect;
  const id = Number(url.split('/').pop());
  const { filename } = await db.get('SELECT filename FROM photos WHERE item_id = ?', id);
  const img = await fetch(`${base}/uploads/${filename}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));
  assert.equal((await fetch(`${base}/uploads/../server.js`)).status, 404);

  // Closed long ago -> photo pruned, post text kept
  await db.run("UPDATE items SET status = 'resolved', closed_at = ? WHERE id = ?", Date.now() - 400 * 86400000, id);
  assert.ok((await prunePhotos()) >= 1);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM photos WHERE item_id = ?', id)).n, 0);
  assert.equal((await fetch(`${base}/uploads/${filename}`)).status, 404);
  assert.equal((await c.get(url)).status, 200);
});

test('admin can switch the colour theme; health check works', async () => {
  const visitor = client();
  assert.match((await visitor.get('/')).text, /data-theme="royal"/);
  const admin = client();
  await admin.get('/login');
  await admin.post('/login', { form: { phone: '9000000001', password: 'adminpass', next: '/admin/settings' } });
  const settings = await admin.get('/admin/settings');
  assert.match(settings.text, /JEC Maroon/);
  await admin.post('/admin/theme', { form: { theme: 'maroon' } });
  assert.match((await visitor.get('/')).text, /data-theme="maroon"/);
  await admin.post('/admin/theme', { form: { theme: 'nope' } });
  assert.match((await visitor.get('/')).text, /data-theme="maroon"/);
  const h = await fetch(`${base}/healthz`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
});
