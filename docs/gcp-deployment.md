# GCP deployment

This guide covers the original shared-account deployment. For private user
workspaces and migration, use [the workspace rollout guide](gcp-workspaces.md).
After workspace cutover, `pnpm deploy:gcp` refuses to restore legacy access.

This implements [ADR-0001](adr/0001-gcp-scheduled-execution.md). Deployment creates
dedicated bot resources in the configured GCP project and region and initializes
new accounts with scheduling paused.
Existing services and databases are not redeployed.

## Resources

| Resource | Name / behavior |
| --- | --- |
| Admin service | `whatsapp-admin`: IAP, request-based billing, min 0, max 2, 256 MiB |
| Summary Job | `whatsapp-summary`: 1 CPU, 512 MiB, one task, 10 minutes, one retry |
| Pairing Job | `whatsapp-pairing`: same image, five minutes, no retry, no Gemini secret |
| Scheduler | `whatsapp-summary`: `0 */4 * * *`, `Europe/Istanbul`, initially paused |
| Control database | `whatsapp-control`: settings versions, sanitized operations, temporary QR |
| Runtime database | `whatsapp-runtime`: auth generations, keys, queue, reports, leases |
| Gemini secret | `whatsapp-gemini-api-key` |
| Container repository | `REGION-docker.pkg.dev/PROJECT_ID/whatsapp-bot` |

The two new Firestore databases do **not** receive the project's free allowance.
Cloud Run, builds, image storage, secrets, and Gemini can also incur charges.

## Deploy with the CLI

Prerequisites: Node 24, pnpm, a working `gcloud auth login`, billing enabled, and
permission to create these resources and IAM bindings. Create `config.json` and
`.env` as described in the README. Copy `.env.gcp.example` to `.env.gcp` and set
your project, region, and administrator email. The deployer reads the local bot configuration only
when initializing Firestore; subsequent deployments preserve saved settings.

```sh
pnpm install --frozen-lockfile
pnpm test
cp .env.gcp.example .env.gcp
# Fill in .env.gcp before deploying.
pnpm deploy:gcp
```

The script builds in Cloud Build and deploys the same image to all three
workloads. Upload allowlists exclude `.env`, `config.json`, local WhatsApp auth,
chat state, Git metadata, and tests. Cloud mode disables conversation logging.
It also suppresses direct library console output: libsignal otherwise prints
session objects outside the Baileys logger. Workers emit structured outcomes,
phases, durations, Web versions, and numeric connection status codes without
provider error objects. Aggregate collection counters distinguish filter/window
exclusions from receive and sync errors without logging message content.
Firestore databases have deletion protection. No service-account keys are
created; Google libraries use the workload's identity.

`.env`, `.env.gcp`, other local `.env.*` files, and `docs/local/` are ignored by
Git and excluded from Docker and Cloud Build uploads. Only placeholder `.example`
files are shared. Keep deployment URLs, release digests, and operator notes under
`docs/local/`. Cloud credentials remain in IAP settings and Secret Manager.

Use `ADMIN_EMAIL=you@example.com` to choose the initial administrator (default:
the active gcloud account). Both IAP access and `ADMIN_EMAILS` in the service must
allow an administrator. Use a single email with the deployment helper; add further
accounts to both layers explicitly.

For a previously built image:

```sh
SKIP_BUILD=1 IMAGE=REGION-docker.pkg.dev/PROJECT_ID/whatsapp-bot/bot:YOUR_TAG \
  pnpm deploy:gcp
```

The admin identity accesses only the control database. Summary/pairing identities
access both databases, using verified database-scoped IAM conditions. Only the
summary identity reads the Gemini secret. Job invocation, execution inspection,
and cancellation permissions are attached to the two bot Jobs. Scheduler invokes
only the summary Job, using OAuth.

These database checks establish **direct read restrictions**, not a complete
boundary against a compromised control plane. `run.jobs.runWithOverrides` can
override container arguments, so admin and Scheduler identities remain trusted
controllers with indirect worker privileges. The browser API accepts only fixed
operation parameters and never arbitrary arguments or environment variables.
If the admin must remain untrusted relative to runtime credentials, introduce a
separate launcher that enforces fixed arguments and remove override permission
from the admin and Scheduler identities.

### Scheduler permission

Cloud Scheduler does not support a condition restricting permissions to one job.
Automatic reconciliation therefore requires a project-level custom role with
exactly these permissions:

```
cloudscheduler.jobs.get
cloudscheduler.jobs.update
cloudscheduler.jobs.pause
cloudscheduler.jobs.enable
```

It cannot create, delete, or directly run jobs, but it can modify other Scheduler
jobs in the project. The admin code uses a fixed job name. After accepting this
scope, grant the role with:

```sh
GRANT_PROJECT_SCHEDULER_ROLE=1 pnpm deploy:gcp
```

Without this grant, settings persist but API reconciliation reports an error.
The deployer can reconcile with `node --env-file=.env.gcp scripts/seed-cloud.js`; this also creates a
missing Scheduler job. Pairing uses reconciliation to pause scheduling, so enable
this permission before using browser pairing. For stricter isolation, deploy in
a dedicated GCP project. [Google's supported condition resources](https://docs.cloud.google.com/iam/docs/conditions-resource-attributes).

### Google sign-in: one-time setup

For a project without an organization, the first OAuth client cannot be created
through the CLI. The deployment can succeed with IAP enabled while browser
requests return 502 until setup is finished.

Open [Cloud Run](https://console.cloud.google.com/run), select your project and
the admin service, and open its **Security** tab,
then **IAP → Edit policy → Configure in IAP**. Configure an **External** OAuth
consent screen and use **Auto generate credentials**, then save.

If **Edit policy** only shows the account allowlist, use
[Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients)
to create a **Web application** client with an **External** audience. Add this
authorized redirect URI, replacing `CLIENT_ID` with the complete client ID:

```text
https://iap.googleapis.com/v1/oauth/clientIds/CLIENT_ID:handleRedirect
```

Apply the client ID and secret to the project's IAP OAuth settings using
`gcloud iap settings set`, following
[Google's custom OAuth instructions](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run#configure_a_custom_oauth_client).
Keep credentials out of source control and command-line arguments. If the consent
screen remains in testing, add the administrator as a test user. Keep the explicit
IAP account allowlist.

Do not make the service public to work around an OAuth setup error. The backend
also verifies the IAP assertion's signature, issuer, audience, and administrator
email. Mutations require matching origin and CSRF cookie/header; QR/status/API
responses are not cached.

### Replace the Gemini key

Update `.env` locally, then upload a new secret version without printing its value:

```sh
node --env-file=.env.gcp scripts/seed-secret.js
```

This checks that Gemini accepts the key before uploading it. New summary
executions use the latest secret version. The admin and pairing Job never receive
the key. Select an available model in Configurations; model availability and quotas
depend on the key's project.

## Link WhatsApp and enable runs

1. Stop the local bot. Keep its session and state files until migration is verified.
2. Open the admin URL printed by deployment and sign in with the allowlisted Google
   account. Check that an unauthenticated browser cannot reach the application.
3. Open **Device connection → Link device**. Scan the QR in the phone's **Linked devices**
   screen. Refreshing the browser resumes polling; cancellation stops the Job.
4. Wait for **Device linked**. After scanning, **Saving initial messages…** means
   the worker is persisting session keys and matching history within its bounded
   synchronization window. Pairing creates no summaries and sends no reports;
   saved messages remain queued for the next summary run. Scheduling stays paused.
   Re-linking preserves queued work.
5. Open **Configurations**, check each configuration and its recipients, and
   select its **Run now** button. Manual runs work with scheduling paused.
   **Run all** processes every saved configuration in one Job. Observe a
   successful report, then enable the desired configurations after offline tests.
6. Verify expected message IDs after one and four hours offline, including group
   messages and captions. Compare them with the source device and inspect report
   delivery. A completed Job or a FULL sync event alone does not prove completeness.
7. Enable scheduled runs on the desired configurations after validation. Start
   with four hours; measure synchronization time, usage, and quota headroom
   before choosing hourly runs.

The device connection page is available at `/#device-connection` on the admin URL
printed by deployment.
Existing `/#whatsapp` links automatically switch to the new anchor.

The configuration list is available at `/#configurations`; use
`/#configurations/ID` to open a specific item. Existing `/#settings` links
redirect to the list. Cards expand and collapse without losing unsaved edits.
Save changes with **Save configuration**; **Reload** discards local edits and
loads the current version. Overview links to the list and shows recent outcomes.
Run now is available on each card, and Run all is at the top of the list.

Each named configuration has independent filters, recipients, model, instructions,
quiet time, time zone, and scheduling state. All share one linked device. Manual
runs include paused schedules; scheduled runs select only enabled configurations
that are due. The same WhatsApp connection collects input into separate queues
for every saved configuration. Pausing stops automatic reports and preserves
pending input. Removal requires no active operation and no pending work.

A shared Scheduler checks due configurations every 15 minutes in UTC and pauses
when all schedules are disabled. Each configuration retains its own local
15-minute, 30-minute, hourly, four-hour, eight-hour, or daily boundaries. The worker saves completed schedule slots
and processes Run all sequentially under one account lease. A failed configuration
does not prevent other selected configurations from completing.

Pending or failed schedule updates are shown separately from enabled/paused state.
Use **Retry schedule update** to reconcile saved changes. Pairing pauses every
configuration; enable the desired schedules again after linking.

A successful execution can have nothing to send. Recent run details distinguish
reports sent, messages waiting for the configured quiet time, and no matching
messages. They also flag receive/sync errors. If a report is missing, compare the
collection counters and full chat names with **Configurations → Chat filters** before
changing recipients or the Gemini key. An empty filter includes every chat.

Reports are delivered at least once. A crash between a confirmed WhatsApp send
and saving its acknowledgement can duplicate that part. Durable recipient/part
progress prevents resending parts already acknowledged. Quiet chats wait for the
next run; a worker does not wait indefinitely for inactivity.

### Optional import of a local session and queue

Use this instead of browser pairing when preserving the current device/session
and pending local work. It requires an **empty cloud runtime account**, a paused
schedule, and a stopped local bot:

```sh
node --env-file=.env.gcp scripts/import-session.js --local-bot-stopped
```

It reads local auth and validated state, preserves filename-normalized encryption
keys, verifies the session without sending summaries, and imports pending messages,
reports, completed IDs, and checkpoints. Source files are untouched. Scheduling
remains paused. Do not restart the local process with the imported session.
A failed verification does not activate the new generation. If the CLI is killed
forcibly during staging, keep scheduling paused and repair or remove that staged
account before retrying; do not delete production queued work.
Finish any saved local report containing more than 200 input message IDs before
importing. Cloud-generated reports cap batches at 100 messages per chat and two
chats per report to stay inside Firestore transaction limits; larger pending
queues are processed over successive batches.

## Verification and operations

`pnpm test` exercises cloud lease loss, crash recovery, partial delivery, auth
serialization/import, schedule conflicts, failed reconciliation, signed identity,
CSRF, QR ownership/expiry, restart after pairing, and stale/disabled execution.
Tests send no live WhatsApp or Gemini requests.

For isolated checks against real Firestore and IAM, run:

```sh
node --env-file=.env.gcp scripts/verify-gcp.js
```

This requires temporary Token Creator access on the three bot service accounts.
It verifies denied runtime/secret reads, uses random synthetic runtime data, and
deletes that data afterward. Remove the temporary impersonation grants afterward.

A smoke test while the account is paused verifies that the container exits without
connecting to WhatsApp. Replace `PROJECT_ID` and `REGION` with your `.env.gcp`
values:

```sh
gcloud run jobs execute whatsapp-summary --project=PROJECT_ID --region=REGION --wait
gcloud scheduler jobs describe whatsapp-summary --project=PROJECT_ID --location=REGION
```

Configuration snapshots are versioned under `configs/ACCOUNT_ID/versions`;
manual requests pin their snapshot and each item has its own edit version.
Saved reports retain their original recipients. Existing settings appear as
**Default configuration** and keep the original runtime queue. New queues use
`accounts/ACCOUNT_ID/configurations/ID`; auth and the lease stay account-wide.
The first configuration change materializes the list and switches to shared
scheduled dispatch. Update both Jobs and the admin image before making that
change; no additional Jobs, Scheduler resources, or IAM grants are required. An expired lease can
be acquired by a new execution, but fenced writes reject the previous owner.
Workers renew every 15 seconds with a 60-second lease. The summary deadline is
570 seconds; pairing is 270 seconds, leaving time for cleanup before platform
timeouts. The admin repairs stale operation status from Cloud Run execution state.

Use Cloud Logging for sanitized worker outcomes and platform failures. Inspect
queue age, failed runs, stale schedule revisions, durations, quotas and billing
before increasing frequency. No alert policy or billing budget is installed by
this deployment.
Logout disables future connections and marks the Scheduler pause pending; use
**Retry schedule update** to apply it. Until reconciliation, scheduled executions
exit without connecting. The worker intentionally has no Scheduler permissions.
