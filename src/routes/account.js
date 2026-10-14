const express = require('express');
const config = require('../config');
const { db } = require('../db');
const auth = require('../auth');
const { safeNext, clean } = require('../helpers');
const { userItems, userResponses } = require('../items');

const router = express.Router();
const authLimit = auth.rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render('login', { title: 'Sign in', next: safeNext(req.query.next), error: null, phone: '' });
});

router.post('/login', authLimit, async (req, res) => {
  const next = safeNext(req.body.next);
  const phone = auth.normalizePhone(req.body.phone);
  const user = phone && await db.get('SELECT * FROM users WHERE phone = ?', phone);
  const fail = (error) => res.status(400).render('login', { title: 'Sign in', next, error, phone: req.body.phone || '' });
  if (!user || !auth.checkPassword(String(req.body.password || ''), user.password_hash)) {
    return fail('Wrong mobile number or password.');
  }
  if (user.is_banned) return fail('This account has been blocked by the admin.');
  await auth.startSession(res, user.id);
  res.redirect(next);
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Create account', next: safeNext(req.query.next), error: null, form: {} });
});

router.post('/register', authLimit, async (req, res) => {
  const next = safeNext(req.body.next);
  const form = {
    name: clean(req.body.name, 80),
    phone: clean(req.body.phone, 20),
    email: clean(req.body.email, 120),
    college_id: clean(req.body.college_id, 40),
    department: config.departments.includes(req.body.department) ? req.body.department : '',
  };
  const password = String(req.body.password || '');
  const phone = auth.normalizePhone(form.phone);
  const fail = (error) => res.status(400).render('register', { title: 'Create account', next, error, form });

  if (form.name.length < 2) return fail('Please enter your full name.');
  if (!phone) return fail('Please enter a valid 10-digit Indian mobile number.');
  if (!form.college_id) return fail('Please enter your enrollment number or employee ID.');
  if (!form.department) return fail('Please choose your department.');
  if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return fail('That e-mail address looks wrong.');
  if (password.length < 6) return fail('Password must be at least 6 characters.');
  if (password !== req.body.password2) return fail('Passwords do not match.');
  if (await db.get('SELECT 1 AS x FROM users WHERE phone = ?', phone)) return fail('An account with this mobile number already exists. Please sign in.');

  const userId = await db.insert(`
    INSERT INTO users (name, phone, email, college_id, department, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, form.name, phone, form.email || null, form.college_id, form.department, auth.hashPassword(password), Date.now());
  await auth.startSession(res, userId);
  res.flash('Welcome! Your account is ready. Tip: turn on notifications so you hear about new posts.');
  res.redirect(next);
});

router.post('/logout', async (req, res) => {
  await auth.endSession(req, res);
  res.redirect('/');
});

router.get('/me', auth.requireLogin, async (req, res) => {
  res.render('me', {
    title: 'My posts',
    items: await userItems(req.user.id),
    responses: await userResponses(req.user.id),
  });
});

router.get('/me/notifications', auth.requireLogin, async (req, res) => {
  const notes = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', req.user.id);
  await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', req.user.id);
  res.locals.unread = 0;
  res.render('notifications', { title: 'Notifications', notes });
});

router.get('/me/unread', (req, res) => {
  res.json({ unread: res.locals.unread });
});

router.get('/me/profile', auth.requireLogin, (req, res) => {
  res.render('profile', { title: 'My profile', error: null });
});

router.post('/me/profile', auth.requireLogin, async (req, res) => {
  const fail = (error) => res.status(400).render('profile', { title: 'My profile', error });
  const name = clean(req.body.name, 80);
  const email = clean(req.body.email, 120);
  const department = config.departments.includes(req.body.department) ? req.body.department : req.user.department;
  if (name.length < 2) return fail('Please enter your full name.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('That e-mail address looks wrong.');

  if (req.body.new_password) {
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!auth.checkPassword(String(req.body.current_password || ''), row.password_hash)) return fail('Current password is wrong.');
    if (String(req.body.new_password).length < 6) return fail('New password must be at least 6 characters.');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(String(req.body.new_password)), req.user.id);
  }
  await db.run('UPDATE users SET name = ?, email = ?, department = ? WHERE id = ?', name, email || null, department, req.user.id);
  res.flash('Profile saved.');
  res.redirect('/me/profile');
});

module.exports = router;
