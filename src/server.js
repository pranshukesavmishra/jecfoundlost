const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const { initPush } = require('./notify');
const helpers = require('./helpers');
const { startJobs } = require('./jobs');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(config.ROOT, 'views'));
app.disable('x-powered-by');
if (config.TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), geolocation=()',
  });
  next();
});

app.get('/sw.js', (req, res) => {
  res.set('Service-Worker-Allowed', '/');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(config.ROOT, 'public', 'sw.js'));
});
app.get('/theme.css', (req, res) => {
  res.type('css').set('Cache-Control', config.IS_PROD ? 'public, max-age=3600' : 'no-cache').send(require('./theme').css);
});
app.use(express.static(path.join(config.ROOT, 'public'), { maxAge: config.IS_PROD ? '1d' : 0 }));
app.use('/uploads', storage.serve());

// For uptime pings and the host's health check.
app.get('/healthz', async (req, res) => {
  try {
    await db.get('SELECT 1 AS ok');
    res.set('Cache-Control', 'no-store').json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(cookieParser());
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '20kb' }));
app.use(auth.loadUser);
app.use(helpers.locals);
// Multipart forms (photo uploads) check CSRF themselves after the files are parsed.
app.use((req, res, next) => (req.is('multipart/form-data') ? next() : auth.checkCsrf(req, res, next)));

app.use(require('./routes/public'));
app.use(require('./routes/account'));
app.use(require('./routes/items'));
app.use(require('./routes/push'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: "We couldn't find that page. It may have been removed." });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500);
  // If the failure happened before page data was loaded (e.g. database down), send plain text.
  if (!res.locals.site) return res.type('text').send('Something went wrong. Please try again in a moment.');
  res.render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
});

/** Connect to the database, create tables, admin account and push keys. */
async function init() {
  await db.ready;
  await initPush();
  await auth.ensureAdmin();
}

if (require.main === module) {
  init().then(() => {
    startJobs();
    app.listen(config.PORT, () => {
      console.log(`${config.site.name} running on http://localhost:${config.PORT} (${db.kind === 'pg' ? 'Postgres' : 'SQLite'})`);
    });
  }).catch((err) => {
    console.error('Startup failed:', err.message);
    process.exit(1);
  });
}

module.exports = app;
module.exports.init = init;
