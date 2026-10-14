# Deploy on Google Cloud Run

The site runs on **Google Cloud Run** (free tier, HTTPS link included). Photos and the database are kept
in a **Cloud Storage bucket**, so nothing is lost when Cloud Run restarts. After the one-time setup,
**every push to GitHub deploys automatically** (after the tests pass).

**Cost:** Cloud Run's free tier (2 million requests/month) is far more than a college needs. Storage in
the Mumbai region costs a few rupees a month for thousands of photos. Google requires a **billing account**
(card) even for free-tier use; new accounts also get free trial credit.

---

## One-time setup (about 10 minutes)

### 1. Make sure you have a billing account
Open **https://console.cloud.google.com/billing** and create a billing account if you don't have one
(Google asks for a card; the free tier still applies). You don't need to create a project: the script can do it.

### 2. Run the setup script in Cloud Shell
1. Open **https://shell.cloud.google.com** (Google's free terminal in the browser).
2. Paste these lines exactly as they are (no project ID needed):
   ```bash
   git clone https://github.com/pranshukesavmishra/jecfoundlost.git
   cd jecfoundlost
   bash deploy/google-cloud-run.sh
   ```
3. The script shows your Google Cloud projects. **Type the number** of the one to use, or **n** to create a new one.
   It links your billing account automatically (if you have one) and asks for your **admin mobile number**
   and an **admin password**, then works for 5–8 minutes.
4. At the end it prints: **`✅ Your site is live: https://jec-lost-found-….run.app`** 🎉

### 3. Turn on automatic deploys from GitHub
The script also prints **5 values**. Open
`https://github.com/pranshukesavmishra/jecfoundlost/settings/variables/actions` → **New repository variable**
and add each one:

| Name | Example value |
|---|---|
| `GCP_PROJECT_ID` | `jec-lost-found-123456` |
| `GCP_REGION` | `asia-south1` |
| `GCP_SERVICE` | `jec-lost-found` |
| `GCP_WIF_PROVIDER` | `projects/1234567890/locations/global/workloadIdentityPools/github/providers/github-repo` |
| `GCP_DEPLOY_SA` | `jec-lostfound-deployer@jec-lost-found-123456.iam.gserviceaccount.com` |

From now on: push to GitHub → **Tests** run → if green, the **deploy-google** job updates the site.
No passwords or keys are stored in GitHub (it uses Google's keyless Workload Identity Federation).

---

## How data is kept safe on Cloud Run

- **Photos** are saved straight to the bucket (`photos/…`).
- **Database**: the app uses SQLite. Every change is copied to the bucket (`db/lostfound.db`) *before* the
  page answers, and the copy is restored when Cloud Run starts a new instance.
- The service runs with **max 1 instance**, so there is only ever one writer.
- During a deploy, the old and new versions overlap for a few seconds. A post submitted in exactly that
  moment could be lost. For a busier site, move to Supabase (below).

Backups: download the database any time with
`gcloud storage cp gs://YOUR_PROJECT_ID-jec-lostfound/db/lostfound.db .`
(Turn on *Object versioning* for the bucket in the console to keep older copies automatically.)

## Moving to Supabase later

1. Create the Supabase project and copy the **Session pooler** connection string (see `docs/DEPLOY.md`, Step 1).
2. Copy the current data across (in Cloud Shell, inside the `jecfoundlost` folder):
   ```bash
   npm ci
   gcloud storage cp gs://YOUR_PROJECT_ID-jec-lostfound/db/lostfound.db .
   DATABASE_URL="postgresql://…" node scripts/migrate-to-postgres.js lostfound.db
   ```
3. Tell Cloud Run to use it:
   ```bash
   gcloud run services update jec-lost-found --region asia-south1 \
     --update-env-vars "^~^DATABASE_URL=postgresql://…"
   ```
   Photos stay in the bucket. Since the database is then Postgres, you can raise `--max-instances` if needed.

## Useful commands

```bash
# Logs
gcloud run services logs read jec-lost-found --region asia-south1 --limit 50
# Change the admin password
gcloud run services update jec-lost-found --region asia-south1 --update-env-vars "^~^ADMIN_PASSWORD=new-password"
# Change expiry rules
gcloud run services update jec-lost-found --region asia-south1 --update-env-vars LOST_EXPIRY_DAYS=7,FOUND_EXPIRY_DAYS=30
# Your own domain: Cloud Run → service → "Manage custom domains" in the console
```

## Troubleshooting

- **"Billing is not enabled"** → link a billing account to the project, run the script again.
- **Build failed with a permission error** → console → IAM → give `PROJECT_NUMBER-compute@developer.gserviceaccount.com`
  the role **Cloud Run Builder**, run the script again.
- **GitHub deploy job fails at "auth"** → check the 5 variables are spelled exactly as above.
- The script is safe to run again at any time (it skips what already exists).
