# Deploy for free: Supabase + Render

Total cost: **₹0**. Time: about 15 minutes. You only need a GitHub account (you already have one).

| Piece | Free plan | What it does |
|---|---|---|
| **Supabase** | 500 MB database | Stores accounts, posts **and photos**. Never lost on redeploy. |
| **Render** | Free web service | Runs the website. Sleeps after 15 min without visitors; the first visit after that takes ~30–50 s. |
| **GitHub Actions** | Free | Runs the tests on every change, and pings the site during college hours so it stays awake. |

---

## Step 1 — Create the database (Supabase)

1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. **New project**
   - Name: `jec-lost-found`
   - Database password: click **Generate a password** and **copy it somewhere safe**.
   - Region: **Southeast Asia (Singapore)** (same region as the website = faster).
   - Click **Create new project** and wait ~2 minutes.
3. Click **Connect** (top of the project page) → find **Session pooler** → copy the connection string. It looks like:
   ```
   postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
   ```
4. Replace `[YOUR-PASSWORD]` with the password from step 2 (remove the square brackets).
   Keep this full line ready, it is your **`DATABASE_URL`**.

> You don't need to create any tables. The app creates them on first start and locks them so
> Supabase's public API can't read them.

## Step 2 — Put the website online (Render)

1. Go to **https://render.com** → **Get Started** → sign in with **GitHub**.
2. Allow Render to access the repository **`jecfoundlost`** when asked.
3. In Render: **New +** → **Blueprint** → pick the `jecfoundlost` repository → **Connect**.
   (Render reads `render.yaml` from the repo and sets everything up.)
4. It asks for three values:
   - **DATABASE_URL** → the line from Step 1.
   - **ADMIN_PHONE** → your 10-digit mobile number (this becomes the admin login).
   - **ADMIN_PASSWORD** → a strong password for the admin.
5. Click **Apply**. The first build takes 2–4 minutes.
6. Open the link Render shows (like `https://jec-lost-found.onrender.com`). 🎉
   Sign in with ADMIN_PHONE / ADMIN_PASSWORD to see the **Admin** menu.

Every time code is pushed to GitHub, Render redeploys automatically.

## Step 3 — Keep it fast during college hours (optional, recommended)

1. On GitHub open the repository → **Settings** → **Secrets and variables** → **Actions** → **Variables** tab.
2. **New repository variable**: name `SITE_URL`, value your Render link (no `/` at the end).
3. Done. GitHub pings the site every 10 minutes from 7 am to 11 pm, so students never wait for it to wake up.
   It also keeps Supabase from pausing the free database after a quiet week.

## Step 4 — Your own address (optional)

Render → your service → **Settings** → **Custom Domains** → add e.g. `lostfound.yourdomain.in` and follow the DNS
instructions. HTTPS is set up automatically. (Push notifications need HTTPS, which Render always provides.)

---

## Changing things later

| What | Where |
|---|---|
| Colour theme | Website → **Admin → Settings → Colour theme** (instant, no redeploy) |
| Add a new theme | `src/config.js` → `themes` list (copy a line, change the colours) |
| Collection points | Website → **Admin → Settings** |
| College logo | Put the file at `public/img/jec-logo.png` and push |
| Categories, departments, campus places | `src/config.js` |
| Expiry days | Render → service → **Environment** → `LOST_EXPIRY_DAYS`, `FOUND_EXPIRY_DAYS` |

## Backups

Supabase → **Database** → **Backups** (daily on paid plans). On the free plan, make a manual backup from time to time:
Supabase → **Database** → **Backups**, or from any computer: `pg_dump "<DATABASE_URL>" > backup.sql`.

## Troubleshooting

- **Render log says `Startup failed: password authentication failed`**: the password inside `DATABASE_URL` is wrong.
  Supabase → Project Settings → Database → **Reset database password**, then update `DATABASE_URL` in Render → Environment.
- **`ENETUNREACH` / `connect ETIMEDOUT`**: you copied the *Direct connection* string. Use the **Session pooler** one.
- **Site shows "Something went wrong"** right after a quiet week: Supabase may have paused the project.
  Open the Supabase dashboard and click **Restore**, then set up Step 3 so it doesn't happen again.
