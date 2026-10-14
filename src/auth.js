const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');

const SESSION_DAYS = 30;
const COOKIE = 'jlf_sid';

const token = () => crypto.randomBytes(24).toString('hex');

/** Normalise an Indian mobile number to its 10 digits, or return null if invalid. */
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.BASE_URL.startsWith('https://'),
    maxAge: SESSION_DAYS * 86400 * 1000,
  };
}

function startSession(res, userId) {
  const id = token();
  db.prepare('INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(
    id, userId, token(), Date.now() + SESSION_DAYS * 86400 * 1000,
  );
  res.cookie(COOKIE, id, cookieOptions());
}

function endSession(req, res) {
  const id = req.cookies[COOKIE];
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  res.clearCookie(COOKIE);
}

// Visitors without an account still need a CSRF token (login / register forms).
const ANON_COOKIE = 'jlf_anon';

/** Loads req.user and sets res.locals.csrf for every request. */
function loadUser(req, res, next) {
  req.user = null;
  const id = req.cookies[COOKIE];
  if (id) {
    const row = db.prepare(`
      SELECT s.csrf, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?
    `).get(id);
    if (row && row.expires_at > Date.now() && !row.is_banned) {
      req.csrf = row.csrf;
      delete row.password_hash;
      req.user = row;
    } else {
      if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      res.clearCookie(COOKIE);
    }
  }
  if (!req.user) {
    let anon = req.cookies[ANON_COOKIE];
    if (!anon || !/^[a-f0-9]{48}$/.test(anon)) {
      anon = token();
      res.cookie(ANON_COOKIE, anon, { ...cookieOptions(), maxAge: 86400 * 1000 });
    }
    req.csrf = anon;
  }
  res.locals.user = req.user;
  res.locals.csrf = req.csrf;
  next();
}

/** Rejects state-changing requests without the right CSRF token. Run after body parsing. */
function checkCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (sent && req.csrf && sent.length === req.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.csrf))) {
    return next();
  }
  res.status(403);
  if (req.xhr || req.get('accept')?.includes('application/json')) return res.json({ error: 'Session expired. Please reload the page.' });
  return res.render('error', { title: 'Session expired', message: 'Your form expired. Please go back, reload the page and try again.' });
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.get('accept')?.includes('application/json')) return res.status(401).json({ error: 'Please sign in first.' });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'Admins only', message: 'You need admin access for this page.' });
}

/** Tiny in-memory fixed-window rate limiter. */
function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many attempts. Please wait a few minutes.' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    if (req.method === 'GET') return next();
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.status(429);
      if (req.get('accept')?.includes('application/json')) return res.json({ error: message });
      return res.render('error', { title: 'Slow down', message });
    }
    next();
  };
}

/** Creates or updates the admin account from ADMIN_PHONE / ADMIN_PASSWORD on startup. */
function ensureAdmin() {
  const phone = normalizePhone(config.ADMIN_PHONE);
  if (!phone || !config.ADMIN_PASSWORD) {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
    if (!admins) console.warn('[admin] No admin account. Set ADMIN_PHONE and ADMIN_PASSWORD to create one.');
    return;
  }
  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) {
    db.prepare("UPDATE users SET role = 'admin', is_banned = 0, password_hash = ? WHERE id = ?")
      .run(hashPassword(config.ADMIN_PASSWORD), existing.id);
  } else {
    db.prepare(`INSERT INTO users (name, phone, department, password_hash, role, created_at)
                VALUES (?, ?, 'Mechatronics Engineering', ?, 'admin', ?)`)
      .run(config.ADMIN_NAME, phone, hashPassword(config.ADMIN_PASSWORD), Date.now());
  }
  console.log(`[admin] Admin account ready for ${phone}`);
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  normalizePhone, hashPassword, checkPassword, startSession, endSession,
  loadUser, checkCsrf, requireLogin, requireAdmin, rateLimit, ensureAdmin, cleanupSessions,
};
