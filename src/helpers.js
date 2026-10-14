const config = require('./config');
const { db, getTheme } = require('./db');
const { icon } = require('./icons');
const { version: themeCssVersion } = require('./theme');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return fmtDate(ts);
}

function timeLeft(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return 'closing soon';
  if (diff < DAY) return `${Math.max(1, Math.floor(diff / HOUR))} h left`;
  return `${Math.ceil(diff / DAY)} days left`;
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

function fmtDay(ymd) {
  if (!ymd) return '';
  const d = new Date(`${ymd}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? '' : fmtDate(d.getTime());
}

/** "Rahul Sharma" -> "Rahul S." so full names are not broadcast publicly. */
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || 'Someone';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// Stable pleasant colour per person for avatar circles.
const AVATAR_COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#2563eb', '#0d9488'];
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const STATUS_LABEL = { open: 'Open', resolved: 'Returned', closed: 'Closed', expired: 'Expired' };

async function locals(req, res, next) {
  const themeId = await getTheme();
  Object.assign(res.locals, {
    theme: config.themes.find((t) => t.id === themeId),
    themeCssVersion,
    site: config.site,
    config,
    timeAgo,
    timeLeft,
    fmtDate,
    fmtDay,
    shortName,
    STATUS_LABEL,
    icon,
    initials,
    avatarColor,
    cat: config.categoryMeta,
    year: new Date().getFullYear(),
    path: req.path,
    title: '',
    unread: req.user
      ? (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', req.user.id)).n
      : 0,
    flash: req.cookies.jlf_flash ? String(req.cookies.jlf_flash).slice(0, 300) : null,
  });
  if (req.cookies.jlf_flash) res.clearCookie('jlf_flash');
  // One-time message shown on the next page (after a redirect).
  res.flash = (msg) => res.cookie('jlf_flash', msg, { httpOnly: true, sameSite: 'lax', maxAge: 60 * 1000 });
  next();
}

const todayIST = () => new Date(Date.now() + 5.5 * HOUR).toISOString().slice(0, 10);

/** Only allow internal redirects after login. */
const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n : '/');

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

module.exports = { locals, timeAgo, timeLeft, fmtDate, shortName, todayIST, safeNext, clean, DAY };
