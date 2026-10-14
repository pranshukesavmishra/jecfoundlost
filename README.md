# JEC Lost & Found

A lost-and-found website for **Jabalpur Engineering College (JEC), Jabalpur**.
**Powered by the Department of Mechatronics Engineering.**

Students and staff post things they **lost** or **found** (with photos). The whole campus can browse and search them and gets push notifications. When someone responds ("I found this" / "This is mine") and the poster confirms, **both people see each other's mobile number** with one-tap Call / WhatsApp. Tickets **close automatically** after 15 days (lost) or 30 days (found). The poster or an admin can also close them.

See [`docs/PLAN.md`](docs/PLAN.md) for the full design.

## Features

- Lost and found posts with up to 4 photos each. Photos are compressed in the browser, so uploads are fast on mobile data.
- Search, category filter, and Lost / Found / Returned tabs.
- Respond flow: **I found this** on lost posts, **This is mine** (with proof) on found posts.
- Mobile numbers stay private until the poster confirms a match.
- Found items can be marked "with me" or "deposited at" a collection point. Admins edit the list of collection points.
- A **secret detail** on found items that only the finder and admins can see, for checking the real owner.
- Push notifications for every new post (or only for your own posts), plus an in-site notification bell.
- Share-to-WhatsApp button on every post.
- Auto-expiry, a reminder 2 days before expiry, and up to 2 extensions per post.
- Admin panel: close, reopen and delete posts; block users; reset passwords; promote admins; edit collection points; see stats.
- Premium, mobile-first design: app-style bottom bar with a quick "+" button, category icons, status tracker on every post, toasts, smooth animations, and automatic dark mode. Can be installed as an app (PWA).

## Deploy (free)

👉 **Follow [`docs/DEPLOY.md`](docs/DEPLOY.md)**: Supabase (database + photos) + Render (website), ₹0/month, about 15 minutes.

## Themes

- **Admin → Settings → Colour theme** switches the whole site's colours instantly (7 built-in themes, including *JEC Maroon* and *Mechatronics Violet*).
- Everyone can switch **light / dark** with the moon/sun button in the header (or Auto in their profile).
- To add a theme, copy a line in the `themes` list in `src/config.js` and change the colours.

## Run it locally

Requires **Node.js 22.13 or newer**. There is nothing else to install: the database is SQLite, which is built into Node.

```bash
npm install
cp .env.example .env        # then edit ADMIN_PHONE / ADMIN_PASSWORD
npm start                   # http://localhost:3000
npm test                    # end-to-end tests (SQLite)
TEST_DATABASE_URL=postgres://… npm test   # same tests against Postgres
```

Sign in with `ADMIN_PHONE` / `ADMIN_PASSWORD` to get the **Admin** menu.

## College logo

The site ships with a placeholder "JEC" emblem. To use the official logo, put the file in `public/img/` named
`jec-logo.png` (or `.jpg`, `.webp` or `.svg`) and restart. It is picked up automatically.

To change the phone app icons as well, replace `public/img/icon-192.png` and `public/img/icon-512.png`.

## Deploy

Everything the app stores (database plus photos) lives in **one folder, `DATA_DIR`** (default `./data`).
Keep that folder on persistent storage and back it up regularly.

### Option A: college server or any Linux VPS (recommended)

```bash
git clone <this repo> && cd jecfoundlost
cp .env.example .env && nano .env          # set BASE_URL, ADMIN_PHONE, ADMIN_PASSWORD
docker compose up -d --build
```

Put Nginx (or Caddy) in front of it with HTTPS. Push notifications need HTTPS.
A minimal Caddyfile:

```
lostfound.yourdomain.in {
    reverse_proxy localhost:3000
}
```

Without Docker, use `npm ci --omit=dev && npm start`, run under `pm2` or systemd.

### Option B: Render + Supabase (free)

See [`docs/DEPLOY.md`](docs/DEPLOY.md). Uses `render.yaml` and a Supabase `DATABASE_URL`, so no disk is needed.

### Option C: Railway / Fly.io with a volume

Deploy the `Dockerfile`, mount a persistent volume at `/app/data` (or set `DATABASE_URL`), and set `TRUST_PROXY=1`, `ADMIN_PHONE`, `ADMIN_PASSWORD`.

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `BASE_URL` | — | Public URL, e.g. `https://lostfound.jec.ac.in`. Used for share links; `https://` turns on secure cookies |
| `TRUST_PROXY` | off | Set to `1` behind Nginx or a PaaS |
| `DATABASE_URL` | — | Postgres connection string (e.g. Supabase). When set, data **and photos** go to Postgres; otherwise a local SQLite file is used |
| `DATA_DIR` | `./data` | Where the SQLite database and photos are kept (when `DATABASE_URL` is not set) |
| `PHOTO_RETENTION_DAYS` | `60` | Photos of posts closed longer ago than this are deleted to save space (`0` = keep forever) |
| `ADMIN_PHONE`, `ADMIN_PASSWORD`, `ADMIN_NAME` | — | Admin account, created or updated on every start |
| `LOST_EXPIRY_DAYS` | `15` | Lost posts close after this many days |
| `FOUND_EXPIRY_DAYS` | `30` | Found posts close after this many days |
| `REMINDER_DAYS_BEFORE` | `2` | When to remind the poster before closing |
| `MAX_EXTENSIONS` | `2` | How many times a poster can extend a post |
| `MAX_POSTS_PER_DAY` | `10` | Anti-spam limit per user |
| `VAPID_SUBJECT` | `mailto:admin@jecjabalpur.ac.in` | Contact address sent to push services |

Push notification keys are generated automatically on the first start and stored in the database.

## Backups

```bash
# while the app is running
sqlite3 data/lostfound.db ".backup data/backup-$(date +%F).db"
tar czf jec-lostfound-backup.tgz data/
```

## Project layout

```
src/
  server.js        app setup
  config.js        college name, categories, departments, places, limits
  db.js            SQLite schema
  auth.js          accounts, sessions, CSRF, rate limits
  notify.js        in-site + web-push notifications
  jobs.js          auto-expiry and reminders (every 15 min)
  routes/          public, account, items, push, admin
views/             EJS pages
public/            CSS, browser JS, service worker, icons
test/              end-to-end tests (node --test)
```

To change the college details, categories (with their icons and colours), departments or campus places, edit `src/config.js`.

Credits: font [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) (SIL Open Font License, bundled in `public/fonts`), icons from [Lucide](https://lucide.dev) (ISC licence).

---

Powered by the **Department of Mechatronics Engineering**, Jabalpur Engineering College.
