# ADR-0002: Private workspaces for users, devices, and schedules

**Date:** 2026-10-09 · **Status:** Accepted and implemented.

## Why change?

The original deployment lets every admitted administrator manage the same WhatsApp
account and configurations. IAP verifies who signed in, but that backend uses one shared
`CONFIG_ID`. Independent users need private devices, settings, and schedules.

This extends [ADR-0001](0001-gcp-scheduled-execution.md); its message collection
and offline-delivery limitations still apply.

## Decision

Give each user a **private workspace**, initially with one owner. Record membership
explicitly so invited collaborators can be supported later.

Keep one shared admin UI and scheduling dispatcher. Give each workspace separate
control/runtime Firestore databases, summary and pairing Jobs, and service accounts.

| Resource | Belongs to |
| --- | --- |
| Linked WhatsApp account/session (“device”) | One workspace |
| Configuration and its schedule | One workspace and one assigned device |
| Session keys and connection lock | The device |
| Message queue, reports, and processing checkpoints | The device/configuration pair |

**Run now** uses a saved configuration. **Run all** runs every saved configuration
in the current workspace, including paused schedules, grouped by device. Requests
retain their configuration snapshot; reports retain their original device and
recipients. A failure on one device must not stop others.

## How isolation works

**At sign-in and on every API request:** use `sub` from a verified IAP JWT as the
user ID, then check workspace membership. Email is for display and invitations.
Reject resources from another workspace, including substituted IDs in request
bodies. Apply this to reads, edits, runs, status, pairing, and cancellation.
Keep CSRF protection and version checks.
[IAP identities](https://docs.cloud.google.com/iap/docs/signed-headers-howto).

Existing `#configurations` and `#configurations/ID` links remain valid; URLs grant
no access. Add device selection, scope browser preferences to the user/workspace,
clear loaded data on identity changes, and keep private responses uncached.

**For devices:** share one renewable, fenced connection lock between summary and
pairing. Re-linking pauses only that device's configurations. Return a temporary
QR only to its authorized initiator. Verify the linked account before activation
and reject accounts already assigned to another workspace.

Re-linking the same account preserves pending work. A different account needs a
new device. Saved configurations keep their assigned device; changing it requires a
new configuration; old reports must never move to the new account.

**For workers:** fix workspace and database IDs in each Job definition. Workers
claim durable requests from their own database and verify ownership before
connecting or sending. The launcher selects registered Jobs on the server and
has no argument/environment override, Job update, or worker impersonation rights.
[Cloud Run permissions](https://docs.cloud.google.com/run/docs/reference/iam/permissions).

Enforce database-scoped IAM and verify effective grants:

- The admin accesses control data, not runtime credentials or messages.
- Workers access only their workspace's control/runtime databases.
- Only summary workers read their workspace's Gemini secret; pairing gets no key.
- Users receive application access, not GCP database or Job permissions.

Firestore server libraries bypass Security Rules and use IAM, so separate
collections alone cannot isolate workers. Broad inherited grants must not defeat
these restrictions.
[Server library security](https://firebase.google.com/docs/firestore/security/insecure-rules),
[database access](https://docs.cloud.google.com/firestore/native/docs/manage-databases#configure_per-database_access_permissions).

## Scheduling and security limits

One Scheduler tick every 30 minutes in UTC invokes an internal dispatcher. A
minimal due-work index identifies workspace Jobs to start; workers check their
own saved schedules, time zones, versions, and completed slots. Retry index updates
and reconcile periodically. Request claims and completed slots prevent duplicate
processing while preserving pending work.

Users edit schedules through the API. Pausing one workspace leaves others running.
Deployment identities manage Scheduler; remove the admin's project-wide Scheduler
editor grant during migration.

The shared admin, dispatcher, and deployment identities remain trusted. A
compromised admin could change recipients even without reading runtime data.
For protection from a compromised shared control plane, use separate admin/worker
deployments and GCP projects with independent access grants.

This adds provisioning and maintenance work. Limit launches, retries, and device
concurrency per workspace. Separate Gemini keys in one provider project still
share its quotas. Audit ownership and outcomes without logging messages, keys,
tokens, or QR challenges.

## Migration and checks

1. Assign existing data to the current owner's workspace. Preserve the session,
   queues, delivery progress, and configuration IDs. New users start empty.
2. Enforce membership checks before admitting independent users. Provision isolated
   databases and fixed Jobs; stop writes while moving and validating runtime state.
3. Switch to the dispatcher, disable the old trigger, reconcile schedule slots,
   and remove obsolete permissions. Prevent old/new workers connecting to the same
   device during cutover.
4. Test with two users: substituted IDs must not expose or control the other's
   resources or QR codes; workers must be denied the other's databases and secrets.
   Verify Run all, pause, pairing, failures, retries, duplicate dispatch, and locks
   stay within the intended workspace/device.

See the [workspace CLI rollout guide](../gcp-workspaces.md) for provisioning,
verified migration, IAM checks and the admin/dispatcher cutover.
