#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT or run pnpm deploy:gcp}"
export GCP_REGION="${GCP_REGION:-europe-west4}"
export CONTROL_DATABASE="${CONTROL_DATABASE:-whatsapp-control}"
export RUNTIME_DATABASE="${RUNTIME_DATABASE:-whatsapp-runtime}"
export CONFIG_ID="${CONFIG_ID:-whatsapp-main}"
export SUMMARY_JOB="${SUMMARY_JOB:-whatsapp-summary}"
export PAIRING_JOB="${PAIRING_JOB:-whatsapp-pairing}"
export SCHEDULER_JOB="${SCHEDULER_JOB:-whatsapp-summary}"
export SCHEDULER_ACCOUNT="whatsapp-scheduler@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
ADMIN_SERVICE="whatsapp-admin"
ADMIN_EMAIL="${ADMIN_EMAIL:-$(gcloud auth list --filter=status:ACTIVE --format='value(account)')}"
PROJECT_NUMBER="$(gcloud projects describe "$GOOGLE_CLOUD_PROJECT" --format='value(projectNumber)')"
GEMINI_SECRET="${GEMINI_SECRET:-whatsapp-gemini-api-key}"
export GEMINI_SECRET
REPOSITORY="${GCP_REGION}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/whatsapp-bot"
IMAGE="${IMAGE:-${REPOSITORY}/bot:$(date -u +%Y%m%d%H%M%S)}"

gcloud services enable run.googleapis.com firestore.googleapis.com cloudscheduler.googleapis.com iap.googleapis.com iam.googleapis.com iamcredentials.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project="$GOOGLE_CLOUD_PROJECT" --quiet
for database in "$CONTROL_DATABASE" "$RUNTIME_DATABASE"; do
  if ! gcloud firestore databases describe --project="$GOOGLE_CLOUD_PROJECT" --database="$database" >/dev/null 2>&1; then
    gcloud firestore databases create --project="$GOOGLE_CLOUD_PROJECT" --database="$database" --location="$GCP_REGION" --type=firestore-native --delete-protection --quiet
  fi
done
for name in whatsapp-admin whatsapp-worker whatsapp-pairing whatsapp-scheduler; do
  if ! gcloud iam service-accounts describe "${name}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --project="$GOOGLE_CLOUD_PROJECT" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$name" --project="$GOOGLE_CLOUD_PROJECT" --display-name="$name" --quiet
  fi
done
for name in whatsapp-admin whatsapp-worker whatsapp-pairing; do
  expression="resource.name=='projects/${GOOGLE_CLOUD_PROJECT}/databases/${CONTROL_DATABASE}'"
  if [[ "$name" != whatsapp-admin ]]; then
    expression="${expression} || resource.name=='projects/${GOOGLE_CLOUD_PROJECT}/databases/${RUNTIME_DATABASE}'"
  fi
  gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:${name}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --role=roles/datastore.user --condition="expression=${expression},title=${name}-databases" --quiet >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$SCHEDULER_ACCOUNT" --project="$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:whatsapp-admin@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --role=roles/iam.serviceAccountUser --quiet >/dev/null
# Scheduler does not support resource.name IAM Conditions. Grant only the four
# reconciliation permissions; job creation stays with the deploying operator.
if [[ "${GRANT_PROJECT_SCHEDULER_ROLE:-0}" == 1 ]]; then
  if gcloud iam roles describe whatsappScheduleEditor --project="$GOOGLE_CLOUD_PROJECT" >/dev/null 2>&1; then
    role_action=update
  else
    role_action=create
  fi
  gcloud iam roles "$role_action" whatsappScheduleEditor --project="$GOOGLE_CLOUD_PROJECT" --title="WhatsApp schedule reconciliation" --permissions=cloudscheduler.jobs.get,cloudscheduler.jobs.update,cloudscheduler.jobs.pause,cloudscheduler.jobs.enable --stage=GA --quiet >/dev/null
  gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:whatsapp-admin@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --role="projects/${GOOGLE_CLOUD_PROJECT}/roles/whatsappScheduleEditor" --condition=None --quiet >/dev/null
fi

if ! gcloud secrets describe "$GEMINI_SECRET" --project="$GOOGLE_CLOUD_PROJECT" >/dev/null 2>&1; then
  gcloud secrets create "$GEMINI_SECRET" --project="$GOOGLE_CLOUD_PROJECT" --replication-policy=automatic --quiet
fi
if [[ -z "$(gcloud secrets versions list "$GEMINI_SECRET" --project="$GOOGLE_CLOUD_PROJECT" --filter=state:ENABLED --limit=1 --format='value(name)')" ]]; then
  node scripts/seed-secret.js
fi
gcloud secrets add-iam-policy-binding "$GEMINI_SECRET" --project="$GOOGLE_CLOUD_PROJECT" --member="serviceAccount:whatsapp-worker@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
if ! gcloud artifacts repositories describe whatsapp-bot --project="$GOOGLE_CLOUD_PROJECT" --location="$GCP_REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create whatsapp-bot --project="$GOOGLE_CLOUD_PROJECT" --location="$GCP_REGION" --repository-format=docker --quiet
fi
if [[ "${INFRA_ONLY:-0}" == 1 ]]; then exit 0; fi
if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  gcloud builds submit --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --config=cloudbuild.yaml --substitutions="_IMAGE=${IMAGE}" --suppress-logs --quiet
fi
COMMON_ENV="GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},GCP_REGION=${GCP_REGION},CONTROL_DATABASE=${CONTROL_DATABASE},RUNTIME_DATABASE=${RUNTIME_DATABASE},CONFIG_ID=${CONFIG_ID},SUMMARY_JOB=${SUMMARY_JOB},PAIRING_JOB=${PAIRING_JOB},SCHEDULER_JOB=${SCHEDULER_JOB},SCHEDULER_ACCOUNT=${SCHEDULER_ACCOUNT}"
for mode in summary pairing; do
  if [[ "$mode" == summary ]]; then
    job="$SUMMARY_JOB"; account=whatsapp-worker; argument=--once; timeout=600s; retries=1
    secret_args=("--set-secrets=GEMINI_API_KEY=${GEMINI_SECRET}:latest")
  else
    job="$PAIRING_JOB"; account=whatsapp-pairing; argument=--pair; timeout=300s; retries=0
    secret_args=(--clear-secrets)
  fi
  gcloud run jobs deploy "$job" --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --image="$IMAGE" --service-account="${account}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --command=node --args="src/cloud/worker.js,${argument}" --set-env-vars="$COMMON_ENV" --cpu=1 --memory=512Mi --tasks=1 --parallelism=1 --task-timeout="$timeout" --max-retries="$retries" "${secret_args[@]}" --quiet
  gcloud run jobs add-iam-policy-binding "$job" --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --member="serviceAccount:whatsapp-admin@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --role=roles/run.jobsExecutorWithOverrides --quiet >/dev/null
  gcloud run jobs add-iam-policy-binding "$job" --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --member="serviceAccount:whatsapp-admin@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --role=roles/run.viewer --quiet >/dev/null
done
gcloud run jobs add-iam-policy-binding "$SUMMARY_JOB" --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --member="serviceAccount:${SCHEDULER_ACCOUNT}" --role=roles/run.jobsExecutorWithOverrides --quiet >/dev/null
node scripts/seed-cloud.js

IAP_AUDIENCE="/projects/${PROJECT_NUMBER}/locations/${GCP_REGION}/services/${ADMIN_SERVICE}"
gcloud run deploy "$ADMIN_SERVICE" --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --image="$IMAGE" --service-account="whatsapp-admin@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com" --set-env-vars="${COMMON_ENV},ADMIN_EMAILS=${ADMIN_EMAIL},IAP_AUDIENCE=${IAP_AUDIENCE}" --cpu=1 --memory=256Mi --min-instances=0 --max-instances=2 --concurrency=20 --timeout=120s --no-allow-unauthenticated --iap --quiet
node scripts/create-iap-identity.js
gcloud run services add-iam-policy-binding "$ADMIN_SERVICE" --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" --role=roles/run.invoker --quiet >/dev/null
gcloud iap web add-iam-policy-binding --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --resource-type=cloud-run --service="$ADMIN_SERVICE" --member="user:${ADMIN_EMAIL}" --role=roles/iap.httpsResourceAccessor --quiet >/dev/null
gcloud run services describe "$ADMIN_SERVICE" --project="$GOOGLE_CLOUD_PROJECT" --region="$GCP_REGION" --format='value(status.url)'
