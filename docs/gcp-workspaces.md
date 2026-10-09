# Private workspaces on GCP

[ADR-0002](adr/0002-user-workspace-isolation.md) is implemented behind workspace
mode. Existing deployments remain shared until the owner migration and admin
cutover below are completed. This guide extends the
[original deployment guide](gcp-deployment.md).

## What gets deployed

| Shared resources | Per workspace |
| --- | --- |
| Existing IAP-protected admin | Control and runtime Firestore databases |
| Private account registry service and database | Summary and pairing Jobs, each with its own service account |
| Dispatcher Job and one 30-minute UTC Scheduler trigger | A Gemini secret readable only by the summary worker |

The registry stores explicit membership using the verified IAP subject, resource
names, dispatch hints and keyed account fingerprints. It contains no message
queues or WhatsApp credentials. Workers call its private service using Google
ID tokens; they cannot read the registry database or its HMAC key directly.
The admin and registry service access workspace control data, never runtime data.

A workspace supports five devices, twenty configurations per device and two
concurrent device operations. Configurations keep their assigned device. Run all
includes paused configurations, groups work by device and reports failures
independently. Queued requests survive launch/index failures; task retries retain
their saved snapshot and delivery progress. Idle worker probes repair missed
dispatch hints once an hour without connecting when no work is due.

The shared control plane remains trusted. Database conditions restrict worker
credentials; application membership checks restrict users. Real IAM verification
is required because inherited grants can defeat intended database restrictions.
Additional databases and workloads also need their own usage/billing assessment;
the original single-account cost assumptions do not cover multiple workspaces.

## Prepare

Use Node 24, pnpm and an authenticated `gcloud`. Start with the existing admin,
IAP/OAuth setup and container repository from the original deployment. Keep
project-specific values in ignored `.env.gcp` and notes in `docs/local/`.

Build the new image using the repository's upload allowlist, replacing the
placeholders with your deployment values:

```sh
gcloud builds submit --project=PROJECT_ID --region=REGION \
  --config=cloudbuild.yaml \
  --substitutions=_IMAGE=REGION-docker.pkg.dev/PROJECT_ID/whatsapp-bot/bot:RELEASE \
  --suppress-logs
```

Set `IMAGE` in `.env.gcp` to the resulting immutable image digest. Keep the
existing database, Job and Scheduler names there; migration needs those values.
An optional `REGISTRY_DATABASE` overrides the default `whatsapp-registry`.

The deploying identity needs resource/IAM administration and permission to
impersonate the admin, dispatcher and the workspace's two workers for read-only
IAM verification. Grant that verification access only to the operator, never
to an application service account. No service-account key files are created.

Every CLI action defaults to a dry run. It prints steps and, for workspace
provisioning, resource commands, while omitting secrets and owner identity.
Append `--apply` to execute the reviewed action:

```sh
pnpm workspace:gcp deploy-shared
pnpm workspace:gcp deploy-shared --apply
pnpm workspace:gcp identity --apply
```

`identity` returns the signed-in Google account's verified email and stable
subject in IAP format. Use that exact subject for `--owner-sub`; email alone
does not establish membership. Obtain another owner's subject from their own
authenticated identity, not from a subject guessed from their email.

Shared deployment creates a private registry service, a dispatcher and a new
Scheduler trigger named `whatsapp-dispatch`. The new trigger starts paused;
the existing admin and old trigger keep their current behavior. The registry
URL is saved for subsequent provisioning commands. The account registry HMAC
key is persistent: do not rotate or replace it without migrating its fingerprints.

## Migrate the existing owner

Finish active operations and stop any local bot sharing this session. Review
the dry run, then migrate using the verified owner's subject and email:

```sh
pnpm workspace:gcp migrate --owner-sub=OWNER_SUB --owner-email=OWNER_EMAIL \
  --from-secret=EXISTING_GEMINI_SECRET
pnpm workspace:gcp migrate --owner-sub=OWNER_SUB --owner-email=OWNER_EMAIL \
  --from-secret=EXISTING_GEMINI_SECRET --apply
```

The command provisions isolated resources and verifies IAM before freezing the
source. It first upgrades legacy Jobs/admin so every edit and launch path honors
the freeze, then pauses the old trigger and records the original configuration
atomically. With the device lease held, it copies the session, keys, queues,
reports and acknowledgements, preserving configuration IDs. It verifies document
counts and digests before activation. Old QR challenges are removed and copied
leases expire; the frozen source and migration checkpoint are retained.

Migration deliberately leaves the old launch paths frozen. Switch the admin,
verify sign-in and saved data, then enable the dispatcher and remove obsolete
permissions:

```sh
pnpm workspace:gcp deploy-admin --apply
pnpm workspace:gcp verify --owner-sub=OWNER_SUB --apply
pnpm workspace:gcp retire-legacy --apply
```

`deploy-admin` preserves IAP/OAuth settings and enables `WORKSPACE_MODE=true`.
`retire-legacy` pauses the old trigger, removes the admin's old Job, Scheduler,
database and Scheduler service-account grants, then resumes the shared trigger.
After cutover, use this CLI for deployments; `pnpm deploy:gcp` refuses to restore
the old shared architecture. Legacy databases remain protected and frozen.

If copying is interrupted, leave the source paused and rerun `migrate` with the
same owner. The checkpoint preserves the original settings. An active workspace
cannot be overwritten by rerunning migration. If activation completed but the
final index/IAP update failed, rerun `provision` for the same owner without a key
file; it preserves existing data and the secret. Re-verify IAM before cutover.

Do not blindly unfreeze the old account or roll the image back after new workers
have written state. Stop dispatch, finish/cancel active operations and reconcile
the new runtime back under a device lease before restoring a legacy deployment.
Otherwise two copies of the session and delivery checkpoints can diverge.

## Add another user

Provide a working Gemini key in a private file outside the repository:

```sh
pnpm workspace:gcp provision --owner-sub=OWNER_SUB --owner-email=OWNER_EMAIL \
  --name="Personal workspace" --gemini-key-file=/PRIVATE/PATH/key.txt
pnpm workspace:gcp provision --owner-sub=OWNER_SUB --owner-email=OWNER_EMAIL \
  --name="Personal workspace" --gemini-key-file=/PRIVATE/PATH/key.txt --apply
```

Provisioning is idempotent and keeps access closed until effective IAM checks
pass. It registers explicit owner membership and adds that email to IAP admission.
New users start with no devices or configurations. Open **Device connection**,
add a device, add a configuration assigned to it and scan the pairing QR.
Only the initiating member sees the QR or can cancel pairing. Re-link the same
WhatsApp account to preserve pending work; a different account needs a new device.
Accounts already assigned elsewhere are rejected. Only never-used devices without
configurations can be removed; linked account ownership is retained.

Use `#configurations`, `#configurations/ID` and `#device-connection/DEVICE_ID`.
Old `#settings` and `#whatsapp` links redirect. Browser preferences are scoped by
subject/workspace; changing identity or losing membership clears loaded private
data. Inviting collaborators and self-service workspace provisioning are not
exposed in the UI; membership is managed by the deployment operator.

## Verify and maintain

Run the existing tests plus the workspace checks with `pnpm test`. They exercise
two-user API/QR isolation, fixed Job launches, account ownership, expired claims,
concurrency, schedule deduplication, partial delivery retries, migration and
effective-IAM failure handling with synthetic data.

`verify --apply` checks real database/secret reads and Job/impersonation permissions
under the workload identities. It does not connect to WhatsApp or send messages.
Check two real admitted users in the browser before treating cutover as complete.
Then run a saved configuration and inspect its delivery outcome. The history and
at-least-once delivery limits from ADR-0001 still apply.

For subsequent releases, update `IMAGE`, rerun `deploy-shared`, run `provision`
for each existing workspace without a key file, then `deploy-admin`. Existing
data and secrets are preserved, and provisioning rechecks IAM. Review operator
impersonation grants after verification. To revoke membership, disable its registry
member record and remove IAP admission. That stops user requests; pause the saved
configurations separately to stop that workspace's scheduled bot activity.
