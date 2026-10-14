// Simulates Google Cloud Run: the app runs with GCS_BUCKET against a fake Cloud Storage server,
// gets restarted on an empty disk, and must come back with all data and photos.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { fakeGcs } = require('./fake-gcs');

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const BUCKET = 'jec-test-bucket';
let gcs;
let gcsUrl;
const children = [];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startApp() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlf-run-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: dataDir, GCS_BUCKET: BUCKET, GCS_ENDPOINT: gcsUrl,
      ADMIN_PHONE: '9000000002', ADMIN_PASSWORD: 'adminpass', DATABASE_URL: '', NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`app did not start:\n${log}`)), 15000);
    const onData = (d) => { log += d; if (/running on/.test(log)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`app exited ${code}:\n${log}`)); });
  });
  child.removeAllListeners('exit');
  return { base: `http://127.0.0.1:${port}`, child, log: () => log };
}

function stopApp(app) {
  return new Promise((resolve) => { app.child.once('exit', resolve); app.child.kill('SIGTERM'); });
}

function client(base) {
  const jar = new Map();
  let csrf = null;
  async function req(method, url, { form, multipart } = {}) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ _csrf: csrf, ...form }).toString();
    } else if (multipart) {
      body = new FormData();
      body.append('_csrf', csrf);
      for (const [k, v] of Object.entries(multipart)) {
        if (Buffer.isBuffer(v)) body.append(k, new Blob([v], { type: 'image/jpeg' }), 'p.jpg'); else body.append(k, v);
      }
      headers.accept = 'application/json';
    }
    const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      if (v === '' || /Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([a-f0-9]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, text, location: res.headers.get('location') };
  }
  return { get: (u) => req('GET', u), post: (u, o) => req('POST', u, o) };
}

before(async () => {
  gcs = fakeGcs();
  await new Promise((r) => gcs.server.listen(0, r));
  gcsUrl = `http://127.0.0.1:${gcs.server.address().port}`;
});

after(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  gcs.server.close();
});

test('data and photos survive a restart on an empty disk (Cloud Run)', async () => {
  let app = await startApp();
  assert.match(app.log(), /saved to gs:\/\/jec-test-bucket/);
  let c = client(app.base);
  await c.get('/register');
  const reg = await c.post('/register', { form: { name: 'Cloud Tester', phone: '9811122233', college_id: 'X1', department: 'Other', password: 'secret12', password2: 'secret12', next: '/' } });
  assert.equal(reg.status, 302);
  // The account must already be in the bucket when the response arrives.
  assert.ok(gcs.objects.has(`${BUCKET}/db/lostfound.db`), 'database uploaded before responding');

  await c.get('/report/lost');
  const r = await c.post('/report/lost', { multipart: { title: 'Grey hoodie', category: 'Clothing / Jacket', location: 'Canteen', photos: JPEG } });
  assert.equal(r.status, 200, r.text);
  const url = JSON.parse(r.text).redirect;
  const photoKeys = [...gcs.objects.keys()].filter((k) => k.startsWith(`${BUCKET}/photos/`));
  assert.equal(photoKeys.length, 1);
  const photoName = photoKeys[0].split('/').pop();

  // Restart on a brand-new empty disk.
  await stopApp(app);
  app = await startApp();
  assert.match(app.log(), /Restored database from bucket/);
  const visitor = client(app.base);
  const home = await visitor.get('/');
  assert.match(home.text, /Grey hoodie/);
  const img = await fetch(`${app.base}/uploads/${photoName}`);
  assert.equal(img.status, 200);
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));

  // The user can still sign in, and the post page works.
  c = client(app.base);
  await c.get('/login');
  const login = await c.post('/login', { form: { phone: '9811122233', password: 'secret12', next: url } });
  assert.equal(login.location, url);
  assert.match((await c.get(url)).text, /Grey hoodie/);

  // Changes made just before shutdown are saved on SIGTERM.
  await c.post(`${url}/resolve`, { form: { note: 'Found it' } });
  await stopApp(app);
  app = await startApp();
  assert.match((await client(app.base).get('/?status=resolved')).text, /Grey hoodie/);
  await stopApp(app);
});
