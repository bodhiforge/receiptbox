# Receipt Box

A self-hosted receipt archive for a small company. Send a receipt photo or PDF to a Telegram bot, and a Mac on your desk stores the original, reads it with on-device OCR and a local vision model, and files it. A private web app handles review, search, reports and year-end exports.

Nothing is sent to a cloud AI service. Originals, the database and recognition all stay on your own machine.

## Features

- **Low-friction capture.** Telegram is the inbox. The bot replies only after the original and its database record are committed to disk.
- **On-device recognition.** Apple Vision OCR plus a local Ollama vision model (Qwen3.5 4B by default, see `src/local-model.mjs`) extract date, total, taxes, currency and category. A durable worker queue survives restarts.
- **Exception-only review.** Receipts that have a date, total and currency and no conflicts are filed automatically. Missing fields, arithmetic conflicts and possible duplicates go to a short "Needs attention" list.
- **Originals are never altered.** Files are content-addressed by SHA-256. Every edit and every automatically applied field is recorded in an audit history. Human edits always win over model output.
- **Reports.** Overview, trends, breakdowns by category or project, and a sortable table, with drill-through to the matching receipts. Currencies are never summed together.
- **Exports.** ZIP archives with human-readable file names, CSV, an HTML index, a manifest of hashes and edit history, and the original bytes.
- **Projects and members.** Group receipts by trip or client. Invite other Telegram users who can upload and correct their own receipts.
- **Recovery.** Verified local snapshots, plus an interface for encrypted off-site backups with [restic](https://restic.net).

## How it works

```text
Telegram bot ─┐                                      ┌─> Web app (review, reports, exports)
              ├─> web process ─> SQLite + originals ─┤
Web upload  ──┘     (src/server.mjs)                 └─> worker (src/worker.mjs)
                                                           ├─ Apple Vision OCR (native/)
                                                           └─ Ollama on 127.0.0.1:11434
```

- **Web process** (`src/server.mjs`): serves the web app, the HTTP API and Telegram polling. It authenticates every request.
- **Shared receipt service** (`src/receipts.mjs`): the single place where receipts are created and changed, for both HTTP and Telegram.
- **Worker** (`src/worker.mjs`): a separate process that claims recognition jobs with leases. A crashed or restarted worker never loses a job, and a stale worker cannot publish results.
- **Review policy** (`src/review-policy.mjs`): decides whether model output can be filed automatically, based on the evidence the model gives for each field.

See [docs/architecture.md](docs/architecture.md) for the storage, queue, authentication and release design, and [docs/changelog.md](docs/changelog.md) for the history of behavior changes.

## Requirements

- macOS with Xcode command-line tools. Apple Vision, PDFKit and the Swift compiler are used for OCR and previews. Developed and run on an Apple silicon Mac mini.
- Node.js 24 or later. The app uses the built-in `node:sqlite` and has no npm dependencies.
- [Ollama](https://ollama.com) with a vision model, for recognition. Intake and manual review work without it.
- A Telegram bot token from [@BotFather](https://t.me/BotFather), for the bot inbox.

## Quick start

```sh
git clone https://github.com/bodhiforge/receiptbox.git
cd receiptbox
npm run build:native        # compiles bin/receipt-image and bin/receipt-preview
ollama pull qwen3.5:4b
npm start                   # web app on http://127.0.0.1:4317
```

To turn on recognition, start the worker in a second terminal with the same data directory:

```sh
RECEIPTBOX_LOCAL_AI=1 npm run worker
```

Data is stored in `./data` unless `RECEIPTBOX_DATA` points somewhere else. Telegram bot pairing is available from **Settings** once the app runs behind an authenticated origin (see [Configuration](#configuration)).

To try the interface with a fictional receipt and a throwaway data directory:

```sh
npm run qa                  # http://127.0.0.1:4318
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Web listener port on loopback. Default `4317`. |
| `RECEIPTBOX_DATA` | Data directory (database, originals, previews, snapshots, bot credentials). |
| `RECEIPTBOX_LOCAL_AI` | Set to `1` to enable the recognition queue. |
| `RECEIPTBOX_LOCATION` | Label shown in the app for where data is stored. |
| `RECEIPTBOX_PUBLIC_ORIGIN` | HTTPS origin users open, for example a Tailscale Serve or custom-domain URL. |
| `RECEIPTBOX_ALLOWED_LOGIN` | Tailscale identity allowed to use the app. Set together with `RECEIPTBOX_PUBLIC_ORIGIN`. |
| `RECEIPTBOX_ACCESS_ISSUER`, `RECEIPTBOX_ACCESS_AUDIENCE` | Cloudflare Access JWT validation for a custom domain. |
| `RECEIPTBOX_OWNER_EMAIL` | Owner's Cloudflare Access email. Only the owner can manage Telegram members. |
| `RECEIPTBOX_TAILSCALE_PORT`, `RECEIPTBOX_TAILSCALE_ORIGIN` | Optional separate Tailscale listener used as an administrative fallback in Cloudflare mode. |

The server only listens on loopback. Put it behind Tailscale Serve or Cloudflare Tunnel with Cloudflare Access; never expose it directly. In Cloudflare mode, the main listener rejects Tailscale identity headers, and the tunnel must never point at the fallback port.

## Using the Telegram bot

Send a photo or a file. Sending as a file keeps the original bytes; Telegram may compress photos. The bot confirms the save, then edits that message with the recognized details or tells you what needs attention.

Reply to a receipt message to add context, either as a plain note or one field per line:

```text
purpose: Client project planning
people: Alex, client representative
project: Website redesign
total: 48.40
date: 2026-10-03
```

Supported fields: `purpose`, `people`, `vehicle`, `payer`, `project`, `reimbursement`, `merchant`, `date`, `total`, `tax`, `currency`, `category`, `tip`, `gst`, `hst`, `pst`, `qst`.

## Deployment on a Mac mini

The app runs as two user LaunchAgents (web and worker) and a daily snapshot job. Templates live in [`launchd/`](launchd/). Copy them to `~/Library/LaunchAgents/` and replace the placeholders.

Releases are immutable directories identified by a hash of their contents:

```sh
node src/release.mjs build . ~/receiptbox/releases     # prints the release id
node src/release.mjs verify ~/receiptbox/releases/<id>
```

Point a `current` symlink at a verified release, then restart the LaunchAgents. Take a verified snapshot first, and never run an older release against a newer database schema. The full procedure, including rollback, is in [docs/architecture.md](docs/architecture.md#releases-and-rollback).

After a reboot, FileVault must be unlocked and the user logged in before user LaunchAgents start.

## Backups

`src/backup.mjs` takes a consistent SQLite online backup and copies the originals it references, then verifies the copy (integrity check, foreign keys and the SHA-256 of every original). Snapshots are kept in `data/snapshots` and are not pruned automatically.

Snapshots on the same disk do not protect against losing the machine. `src/recovery.mjs` backs up a verified snapshot to an encrypted restic repository and can restore and verify it:

```sh
node src/recovery.mjs init    /private/backup-config.json
node src/recovery.mjs backup  /private/backup-config.json /path/to/verified/snapshot
node src/recovery.mjs check   /private/backup-config.json
node src/recovery.mjs restore /private/backup-config.json SNAPSHOT_ID /new/empty/restore-path
```

The config file contains `repository`, `passwordFile` and optionally `binary`. Bot credentials are never included in snapshots or backups.

## Project layout

```text
src/        server, worker and domain modules
public/     web client (plain ES modules and CSS, no build step)
native/     Swift helpers for OCR image preparation and previews
scripts/    isolated QA, integration, migration and runtime checks
test/       node:test suites
launchd/    LaunchAgent templates
docs/       architecture notes and changelog
```

## Testing

```sh
npm run check   # syntax check for every module
npm test        # isolated temporary stores and a fake Telegram transport
```

The native preview test runs only when `bin/receipt-preview` exists. The encrypted backup test runs only when restic is installed.

## Limitations

- Recognition can be wrong. Blurry, faded, handwritten, multi-transaction and card-slip-only receipts often need manual correction.
- Filing a receipt records an expense. It is not a tax or deductibility decision, and the app does not do currency conversion, bank reconciliation or tax returns.
- Telegram is a third-party transport. Local recognition does not make Telegram end-to-end encrypted.
- The interface is English only. The bot also accepts a few Chinese field labels for compatibility.

## License

[MIT](LICENSE)
