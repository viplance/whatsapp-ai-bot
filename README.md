# WhatsApp AI Summary Bot

Collects WhatsApp text messages and captions, summarizes quiet chats with Gemini,
and delivers reports to configured WhatsApp recipients.

## Setup

Use the Node version in `.nvmrc` (Node 24.14.1 or newer) and pnpm 10.12.4.

```sh
pnpm install
cp config.json.example config.json
```

Copy `.env.example` to `.env`, set `GEMINI_API_KEY`, adjust `config.json`, then run:

```sh
pnpm start
```

Scan the terminal QR code in WhatsApp → Linked devices. Session credentials are
stored in `auth_info_baileys/`.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `period` | `"60min"` | Scan interval; at least one second. Supports `ms`, `s`, `min`, `m`, `h`, or minutes as a number. |
| `waitForNoActivity` | `"0"` | Required quiet time since the newest message in a chat; zero disables the gate. |
| `filters` | `[]` | Case-insensitive substrings of group or sender/contact names; Turkish `I/İ/ı` variants match consistently. An empty array includes every chat. |
| `phones` | `["own"]` | At least one recipient: `"own"` or an international phone number. |
| `model` | `"gemini-2.5-flash"` | Gemini model ID available to your API key. |
| `systemInstruction` | `""` | Instructions for the summaries. The example requests Russian summaries. |
| `summaryConcurrency` | `2` | Maximum chats summarized concurrently, from 1 to 10. |
| `defaultLookbackHours` | `24` | History window when no valid saved checkpoint exists. |
| `showScanLogs` | `true` | Log summaries, ingestion counts and successful deliveries. |

To replay history from an explicit date:

```sh
pnpm start --since=2026-10-01
```

The override persists. It allows already completed messages after that date to
be summarized again and preserves pending reports and their delivery progress.
Replay depends on the history WhatsApp supplies to the linked device.

## Recovery and limits

`scan-state.json` contains the pending messages, message IDs, generated reports,
recipient/part delivery progress, and separate scan and history checkpoints.
Writes use a flushed temporary file and an atomic rename. Existing checkpoints
containing only `lastScanTime` migrate automatically on the next write. Invalid
queue data stops startup so it can be repaired without discarding pending work.
The checkpoint contains chat content; it is ignored by Git and written with
owner-only permissions. Run one bot process per project/state file.

Only one scan runs at a time. Failed summaries remain queued. Failed deliveries
retry the stored report without regenerating summaries or resending completed
parts. Message IDs deduplicate overlapping live/history events and reconnects.
Completed IDs are retained for at least 30 days and longer when they are still
inside the active history replay window. Pending messages are retained until
their report has been delivered to every recipient.

History batches are ingested sequentially. The persisted history floor advances
only for a full sync reporting 100% progress; Baileys' `isLatest` flag marks the
first notification, not completion. When completion is unavailable, scans start
after 75 seconds and history continues to use its previous replay floor.

Chats are processed in batches of roughly 24,000 text characters. Oversized
messages are summarized in bounded prompts and their partial summaries combined.
Gemini requests have a 60-second timeout, with up to three attempts for temporary
failures. Reports are split into parts of at most 3,500 UTF-16 characters.

Delivery is **at least once**: a crash after WhatsApp accepts a part but before its
progress is saved, or a network error with an ambiguous send result, can still
cause that part to be resent. WhatsApp delivery and the local checkpoint cannot
be committed atomically.

## GCP deployment

Cloud mode uses a scheduled summary Job, a temporary pairing Job, and an
IAP-protected admin UI. Firestore stores configuration, session keys, and queued
work; Secret Manager holds the Gemini key. Local continuous mode stays available.

Follow the [CLI deployment guide](docs/gcp-deployment.md). See
[ADR-0001: Scheduled execution on GCP](docs/adr/0001-gcp-scheduled-execution.md)
for the architecture, schedule semantics, and cost estimates.

Keep project-specific deployment parameters in `.env.gcp` (copy
`.env.gcp.example`). Local environment files and `docs/local/` deployment notes
are ignored by Git and excluded from build uploads.

For a finite run using local files:

```sh
pnpm start --once
```

## Tests

```sh
pnpm test
```

Tests use isolated temporary state files, mocked sockets, fake timers and a
mocked Gemini transport. They require no API key or WhatsApp login and send no
live messages.
