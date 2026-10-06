# Architecture

Receipt Box is one Node.js application with two processes, a SQLite database and a directory of content-addressed originals, all on one Mac. This document describes how data is stored, how recognition is queued, how requests are authenticated and how releases are rolled out.

## Processes and modules

The shared receipt service in `src/receipts.mjs` owns validation, original storage, audit events, receipt updates and recognition acceptance. HTTP and Telegram call this service directly. `src/database.mjs` applies ordered transactional migrations and refuses a schema from a newer release. Migration 4 separates immutable documents from expense/document links; existing receipt IDs, file IDs, hashes and original filenames are preserved. The `receipts` table holds expenses; `files` is a compatibility view over documents and their links.

`src/originals.mjs` writes a private temporary file, syncs it, publishes it, syncs the directory and verifies the content hash before returning. Pre-existing damaged bytes are retained in quarantine and repaired from a complete matching upload. Receipt creation, source mapping, audit event, search projection and recognition enqueue share one database transaction. A restart reconciles legacy receipts missing jobs. Unreferenced files from interrupted transactions cannot become false saved acknowledgements.

`src/worker.mjs` runs separately from the web/Bot process. SQLite transactional claims and renewable leases prevent double execution ownership. Expired jobs recover, stale owners cannot publish, and a changed document set supersedes old extraction. Pipeline version is recorded alongside model and evidence. `src/notifications.mjs` reads a separate durable outbox; failed delivery never blocks recognition. Telegram polling commits updates and offset together into a durable inbox, then processes them with retry backoff. Network ambiguity may repeat a notification; no exactly-once network-delivery claim is made.

The list API returns bounded pages (50 by default, at most 100) without audit history or AI evidence. Details are loaded separately. SQL predicates use indexed date/category/currency/status fields and a transactionally updated Unicode-normalised search projection. The monthly reporting API uses the same stored bookkeeping values and shared aggregation rules; selecting a page or search never changes overall dashboard totals. `/api/health` exposes schema, worker lease/heartbeat, intake backlog and notification state through the existing private authentication boundary.

## Recognition and automatic filing

Uploads are treated as company receipts. Local recognition automatically saves supported fields and files receipts when date, total and currency are present without concrete date, document or arithmetic conflicts. Merchant is helpful identity but not required; missing currency defaults to CAD unless the receipt shows conflicting or foreign-currency evidence. A model-filled subtotal needs an explicit subtotal or pre-tax label; balances, current charges and amount due do not count. Model confidence labels alone do not require review. Evidence matching is a heuristic, not an accuracy guarantee; originals and every applied field change remain available for correction.

Tax amount, named tax types, payer, purpose, attendees and vehicle are optional. Missing tax stays unknown, never zero. Categories are suggestions; unsupported categories default to Other. Filing records an expense, not a tax-deductibility decision. Model notes are retained in collapsed evidence, not presented as tasks. Human-entered values, including explicitly cleared fields, are preserved. Each automatic application records its job, model, policy version and changes. Existing ready results receive the same policy once at startup without sending old Telegram notifications again.

Local recognition bounds evidence to short excerpts and uses a 4096-token output budget. Truncated output is rejected explicitly; worker failure logs contain job/attempt/error codes, never model text. Company configuration is not sent as extraction evidence.

Expense categories include Utilities, Rent & workspace, Repairs & maintenance, Advertising & marketing, Training & books, and Shipping & postage. Uncertain classification stays Unclassified without blocking filing. The local model stays warm for five minutes after use to reduce reloads for consecutive receipts.

Category recovery uses explicit human category corrections for an exact normalized merchant, excluding mixed retailers, trashed examples, and conflicting categories. BC Hydro/FortisBC have a utility-provider rule. Remaining uncertain categories get at most one local, text-only classification pass (30-second deadline); errors preserve the primary recognition result. Stored category evidence records the source. Existing filed receipts are not bulk reclassified.

## Duplicates

A match on normalized merchant, date, currency and amount requires confirmation. The new original is retained and the receipt appears in Needs attention; it is excluded from Spending, project amounts and export summaries. Exported detail rows and originals remain available, labeled Pending duplicate confirmation. **Use existing** moves the new receipt to recoverable Trash; **Keep both** allows both amounts to count. Restoring an upload discarded as a duplicate requires confirmation again. Decisions are version-checked and audited; changing the matching fields can require a new decision. Telegram actions require an authorized sender, an owned receipt and a mapped bot message. Exact-file hash deduplication remains automatic.

Database schema 7 adds duplicate state. Before deployment, retain a verified snapshot and the previous release. An older release cannot open schema 7; a rollback must restore the pre-upgrade snapshot as well. No historical Telegram notifications are replayed.

## Previews

The authenticated server generates display previews on demand using the bundled `receipt-preview` Swift helper (AppKit/PDFKit). PDF pages render individually, including documents longer than the eight-page AI limit; HEIC and supported image formats become JPEG previews. The viewer supports page navigation, fit, 2× and 3× zoom with scrolling. Derivatives have a maximum 3000-pixel edge and live in `data/previews/v1`; originals and exports remain unchanged. Preview jobs are serialized and deduplicated, time-limited, published atomically and regenerable. Compile it with `npm run build:native` before building a release.

## Persistence and recovery

SQLite uses WAL and FULL synchronous writes. Originals are SHA-256 addressed, fsynced before a committed record and successful acknowledgement. Duplicate bytes resolve to the existing receipt. Every edit and accepted suggestion is logged; optimistic versions and original fingerprints reject stale recognition actions.

`data/telegram-private.json` is mode 0600 and never returned by APIs or included in exports/snapshots. It contains the bot token and paired owner. Only the paired private Telegram account is accepted. Poll offsets and receipt-message mappings persist. Result message IDs are stored durably, and replies/buttons on those messages remain linked to the receipt. Known successful deliveries are not sent again. A crash or lost network response at a send boundary can repeat a reply, but cannot duplicate original-byte records.

`src/backup.mjs` uses SQLite online backup and copies the exact originals referenced by that database snapshot. APFS clone copies avoid repeatedly allocating unchanged original bytes. Each snapshot is verified by reopening a separate database copy, SQLite integrity/foreign-key checks and SHA-256 checks of every original. Daily snapshots are kept under `data/snapshots`; there is no automatic pruning. Monitor free space.

**Snapshots are on the same disk. They help recover from application mistakes, but do not protect against machine loss, theft or disk failure. An independent encrypted backup destination is still required.** Bot credentials are excluded; reconnect the bot after restoring to a new machine.

Restore procedure: stop only Receipt Box, preserve its current data directory, copy a chosen verified snapshot's `receipts.sqlite` and `originals` into a new private data directory, restore the protected bot configuration separately if appropriate, point `RECEIPTBOX_DATA` at the restored directory and restart. Never overwrite a live SQLite/WAL database in place. `verifySnapshot(folder)` checks a snapshot without modifying the live store.

## Authentication

The server listens only on loopback and trusts exactly one proxy per listener.

Cloudflare mode requires RECEIPTBOX_ACCESS_ISSUER and RECEIPTBOX_ACCESS_AUDIENCE, plus RECEIPTBOX_PUBLIC_ORIGIN for the domain. The primary loopback listener (4317) validates RS256 Access application JWTs, including issuer, audience, expiry and human identity. Access policies define the allowed users. Caller-supplied Tailscale identity headers are never accepted on this listener. Public signing keys are cached for five minutes; verification failures deny access.

The optional fallback runs on a distinct loopback port, RECEIPTBOX_TAILSCALE_PORT (4319), with RECEIPTBOX_TAILSCALE_ORIGIN and the existing RECEIPTBOX_ALLOWED_LOGIN identity. Tailscale Serve must forward its existing private URL to this fallback port; Cloudflare Tunnel must only forward to the primary port. Each listener validates its own Host and mutation Origin. Bot links use the new public origin. Do not configure a tunnel route to the fallback port.

### Telegram members

Settings → Members lets the owner create a single-use invitation valid for 24 hours, revoke unused invitations, and remove members. The recipient opens the link and confirms **Join company** in a private Telegram chat. The original paired account remains owner and cannot be removed. Members can upload and edit only receipts whose original upload event identifies their Telegram user ID. Duplicate uploads do not grant edit ownership. Removal preserves originals and upload history and stops new intake, edits, and result notifications to that member.

Set `RECEIPTBOX_OWNER_EMAIL` to the owner's Cloudflare Access login email. Member management checks the verified JWT email; it fails closed when this setting is missing. The existing owner-only Tailscale listener remains an administrative fallback. Telegram invitations do not grant website access. Invitations are stored as SHA-256 hashes in SQLite; the raw share link is returned only on creation. No invitation is sent automatically. Membership and invitation state are included in database snapshots; bot credentials remain separate.

## Releases and rollback

1. Build from a clean, committed checkout with compiled helpers (`npm run build:native`). Run `npm run check` and `npm test` there.
2. Take and verify a consistent snapshot. Before the final migration, briefly stop only Receipt Box; take a final snapshot so no intervening writes can be missed. Preserve its bot configuration and LaunchAgent plists separately on the host.
3. Run `node src/release.mjs build <checkout> <app-root>/releases` and `node src/release.mjs verify <release>`. The immutable release ID hashes every included source and helper file. Never edit an active release in place.
4. Atomically replace `current` with a symlink to the verified release. Web, worker and snapshot LaunchAgents use the current release and the unchanged authoritative data path.
5. Verify migration version, original hashes, private HTTP access, worker health and bot pairing. Keep the previous release and pre-migration snapshot.

Rollback must preserve the current data directory before any restore. Never run old code against a newer schema, or overwrite a live WAL database. For an incompatible schema, restore the pre-migration snapshot into a **new** data directory, preserve later writes for reconciliation, and explicitly point the app at the recovered copy. A release switch alone is safe only when its schema compatibility has been verified. This avoids silently discarding receipts uploaded after deployment.

Release builds contain runtime code only: `src/`, `public/`, `scripts/`, `native/`, the compiled helpers in `bin/`, `package.json`, `README.md` and `LICENSE`. Tests and documentation stay in the repository. LaunchAgents run `current/src/server.mjs`, `current/src/worker.mjs` and `current/src/backup.mjs`.

## Performance baseline

With 10,000 fictional records, 30 measured backend list and report queries had a P95 of 25.52 ms against a 300 ms budget. The list API is paginated and never returns audit history or model evidence; details load separately.
