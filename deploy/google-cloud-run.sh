#!/usr/bin/env bash
# One-time setup + first deploy of JEC Lost & Found on Google Cloud Run.
#
# Run it in Google Cloud Shell (https://shell.cloud.google.com) from the project folder:
#   bash deploy/google-cloud-run.sh
#
# What it does (safe to run again):
#   1. enables the needed Google Cloud services
#   2. creates a Cloud Storage bucket for photos and the database copy
#   3. builds and deploys the site to Cloud Run (public HTTPS link)
#   4. sets up keyless "deploy from GitHub" (Workload Identity Federation)
#      and prints the 5 values to paste into GitHub -> Settings -> Variables
set -euo pipefail

REGION="${REGION:-asia-south1}"                       # Mumbai
SERVICE="${SERVICE:-jec-lost-found}"
GITHUB_REPO="${GITHUB_REPO:-pranshukesavmishra/jecfoundlost}"
POOL="github"
PROVIDER="github-repo"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f package.json && -f Dockerfile ]] || die "Run this from the jecfoundlost folder (cd jecfoundlost)."

# ---------------------------------------------------------------- project
# Use the selected project if it exists; otherwise let the user pick one or create one.
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -n "$PROJECT_ID" ]] && ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Project \"$PROJECT_ID\" was not found (or you don't have access to it)."
  PROJECT_ID=""
fi
if [[ -z "$PROJECT_ID" ]]; then
  mapfile -t PROJECTS < <(gcloud projects list --format='value(projectId)' --sort-by=projectId 2>/dev/null || true)
  CHOICE="n"
  if ((${#PROJECTS[@]})); then
    say "Which Google Cloud project should the site use?"
    for i in "${!PROJECTS[@]}"; do printf '  %d) %s\n' "$((i + 1))" "${PROJECTS[$i]}"; done
    echo "  n) Create a new project"
    read -rp "Type a number (or n): " CHOICE
  fi
  if [[ "$CHOICE" =~ ^[0-9]+$ ]] && ((CHOICE >= 1 && CHOICE <= ${#PROJECTS[@]})); then
    PROJECT_ID="${PROJECTS[$((CHOICE - 1))]}"
  elif [[ "$CHOICE" == [nN] ]]; then
    PROJECT_ID="jec-lost-found-$((RANDOM % 900000 + 100000))"
    say "Creating project $PROJECT_ID"
    gcloud projects create "$PROJECT_ID" --name="JEC Lost and Found" --quiet
  else
    die "Please type one of the numbers shown, or n."
  fi
fi
gcloud config set project "$PROJECT_ID" >/dev/null 2>&1
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
BUCKET="${BUCKET:-${PROJECT_ID}-jec-lostfound}"
RUN_SA="jec-lostfound-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="jec-lostfound-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
BUILD_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

say "Project: $PROJECT_ID  |  Region: $REGION  |  Service: $SERVICE"

# ---------------------------------------------------------------- admin account
EXISTING=false
if gcloud run services describe "$SERVICE" --region "$REGION" >/dev/null 2>&1; then EXISTING=true; fi
ADMIN_PHONE="${ADMIN_PHONE:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [[ -z "$ADMIN_PHONE" ]]; then
  if $EXISTING; then
    read -rp "Admin mobile number (press Enter to keep the current one): " ADMIN_PHONE
  else
    read -rp "Admin mobile number (10 digits, this is the admin login): " ADMIN_PHONE
  fi
fi
if [[ -n "$ADMIN_PHONE" ]]; then
  [[ "$ADMIN_PHONE" =~ ^[6-9][0-9]{9}$ ]] || die "Mobile number must be 10 digits, e.g. 9876543210."
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    read -rsp "Admin password (at least 6 characters): " ADMIN_PASSWORD; echo
  fi
  [[ ${#ADMIN_PASSWORD} -ge 6 ]] || die "Password must be at least 6 characters."
  [[ "$ADMIN_PASSWORD" != *"~"* ]] || die "Please don't use the ~ character in the password."
elif ! $EXISTING; then
  die "An admin mobile number is needed for the first deploy."
fi

# ---------------------------------------------------------------- services
say "Enabling Google Cloud services (takes a minute the first time)"
gcloud services enable cloudbilling.googleapis.com --quiet
billing_enabled() { [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" == "True" ]]; }
if ! billing_enabled; then
  # Link a billing account automatically if the user has one.
  mapfile -t ACCOUNTS < <(gcloud billing accounts list --filter=open=true --format='value(name.basename())' 2>/dev/null || true)
  ACCOUNT=""
  if ((${#ACCOUNTS[@]} == 1)); then
    ACCOUNT="${ACCOUNTS[0]}"
  elif ((${#ACCOUNTS[@]} > 1)); then
    say "Which billing account should pay (Cloud Run's free tier covers normal college use)?"
    mapfile -t NAMES < <(gcloud billing accounts list --filter=open=true --format='value(displayName)')
    for i in "${!ACCOUNTS[@]}"; do printf '  %d) %s (%s)\n' "$((i + 1))" "${NAMES[$i]:-}" "${ACCOUNTS[$i]}"; done
    read -rp "Type a number: " CHOICE
    if ! [[ "$CHOICE" =~ ^[0-9]+$ ]] || ((CHOICE < 1 || CHOICE > ${#ACCOUNTS[@]})); then die "Please type one of the numbers shown."; fi
    ACCOUNT="${ACCOUNTS[$((CHOICE - 1))]}"
  fi
  if [[ -n "$ACCOUNT" ]]; then
    say "Linking billing account $ACCOUNT to $PROJECT_ID"
    gcloud billing projects link "$PROJECT_ID" --billing-account="$ACCOUNT" --quiet >/dev/null
  fi
  billing_enabled || die "Billing is not enabled for $PROJECT_ID. Cloud Run's free tier still needs a billing account (a card):
  1. Open https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID
  2. Create or link a billing account
  3. Run this script again:  bash deploy/google-cloud-run.sh"
fi
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com compute.googleapis.com \
  storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --quiet

# ---------------------------------------------------------------- storage
say "Cloud Storage bucket gs://$BUCKET (photos + database copy)"
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention --quiet
fi

# ---------------------------------------------------------------- service accounts
say "Service accounts and permissions"
ensure_sa() {
  local name="$1" title="$2"
  if ! gcloud iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$name" --display-name="$title" --quiet
    sleep 5   # new accounts take a moment to become usable
  fi
}
ensure_sa jec-lostfound-run "JEC Lost & Found (runtime)"
ensure_sa jec-lostfound-deployer "JEC Lost & Found (GitHub deploys)"

project_role() {
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="$1" --role="$2" --condition=None --quiet >/dev/null
}
# The running site may read/write only its own bucket.
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$RUN_SA" --role=roles/storage.objectAdmin --quiet >/dev/null
# Cloud Build (deploy from source) uses the default compute account.
project_role "serviceAccount:$BUILD_SA" roles/run.builder 2>/dev/null \
  || project_role "serviceAccount:$BUILD_SA" roles/cloudbuild.builds.builder \
  || echo "Note: could not grant build permissions to $BUILD_SA; if the build fails, grant it 'Cloud Run Builder' in IAM."
# GitHub deployer.
for role in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin roles/storage.admin \
            roles/serviceusage.serviceUsageConsumer roles/iam.serviceAccountUser roles/logging.viewer; do
  project_role "serviceAccount:$DEPLOY_SA" "$role"
done

# ---------------------------------------------------------------- deploy
say "Building and deploying (3–6 minutes the first time)"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUN_SA" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 1 \
  --concurrency 80 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 60 \
  --update-env-vars "NODE_ENV=production,TRUST_PROXY=1,GCS_BUCKET=$BUCKET" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
ENV_UPDATE="^~^BASE_URL=${URL}"
if [[ -n "$ADMIN_PHONE" ]]; then ENV_UPDATE+="~ADMIN_PHONE=${ADMIN_PHONE}~ADMIN_PASSWORD=${ADMIN_PASSWORD}"; fi
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "$ENV_UPDATE" --quiet >/dev/null

# ---------------------------------------------------------------- GitHub -> Google (keyless)
say "Letting GitHub ($GITHUB_REPO) deploy without passwords or keys"
if ! gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions" --quiet
fi
if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --location=global --workload-identity-pool="$POOL" --display-name="GitHub repo" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'" --quiet
fi
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" \
  --quiet >/dev/null

cat <<EOF

$(printf '\033[1;32m')✅ Your site is live:  ${URL}$(printf '\033[0m')

Sign in with your admin mobile number to see the Admin menu.

To let GitHub deploy automatically on every push, open
  https://github.com/${GITHUB_REPO}/settings/variables/actions
and add these 5 repository variables (New repository variable):

  GCP_PROJECT_ID     ${PROJECT_ID}
  GCP_REGION         ${REGION}
  GCP_SERVICE        ${SERVICE}
  GCP_WIF_PROVIDER   projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
  GCP_DEPLOY_SA      ${DEPLOY_SA}

Later, to switch to Supabase: see docs/DEPLOY-GOOGLE.md ("Moving to Supabase").
EOF
