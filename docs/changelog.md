# Changelog

Notable behavior changes, newest last. Versions follow `package.json`.

## Exception-only filing (0.3.1)

Uploads are treated as company receipts. Local recognition automatically saves supported fields and files receipts when merchant, date, total and currency are present without concrete date, document or arithmetic conflicts. Model confidence labels alone do not require review. Evidence matching is a heuristic, not an accuracy guarantee; originals and every applied field change remain available for correction.

Tax amount, named tax types, payer, purpose, attendees and vehicle are optional. Missing tax stays unknown, never zero. Categories are suggestions; unsupported categories default to Other. Filing records an expense, not a tax-deductibility decision. Model notes are retained in collapsed evidence, not presented as tasks. Human-entered values, including explicitly cleared fields, are preserved. Each automatic application records its job, model, policy version and changes. Existing ready results receive the same policy once at startup without sending old Telegram notifications again.

## Upload and preview flow (0.3.2)

Choosing or dropping files saves them immediately without a second confirmation or opening an edit form. Processing receipts are listed separately from exceptions. A single Save recalculates remaining exceptions and files corrected receipts, returning to the same list rather than opening the next record. Document-level exceptions require an explicit document check; optional notes cannot resolve unreadable amounts.

The authenticated server generates display previews on demand using the bundled `receipt-preview` Swift helper (AppKit/PDFKit). PDF pages render individually, including documents longer than the eight-page AI limit; HEIC and supported image formats become JPEG previews. The viewer supports page navigation, fit, 2× and 3× zoom with scrolling. Derivatives have a maximum 3000-pixel edge and live in `data/previews/v1`; originals and exports remain unchanged. Preview jobs are serialized and deduplicated, time-limited, published atomically and regenerable. Compile it with `npm run build:native` before building a release.

## Interface and feedback (0.3.3)

All interface and bot feedback uses English. The archive opens with the current calendar month's CAD spending, fuel and meals totals, then a compact upload control and receipt list. The month total counts recorded values by receipt date; other currencies remain separate in Monthly overview. Merchant or custom name is the list title; amount and currency have their own column. Pending recognition stays neutral; only actionable exceptions use amber. Resolve buttons open and focus the relevant field. Evidence stays collapsed.

`public/feedback.mjs` supplies common state language for the website and Telegram. A save acknowledgement confirms original storage, a normal result is a short silent notification with a View receipt button, and an exception names the specific action with a Resolve details button. Duplicate acknowledgements do not claim that recognition restarted. Existing durable delivery and pairing checks are preserved. Chinese input aliases remain accepted for compatibility; generated interface text is English. No existing Telegram messages are rewritten or resent during deployment.

## Receipt views (0.3.6)

Receipts is one sidebar destination. All, Needs attention, Processing and Filed are status tabs above the same searchable list. Switching tabs preserves active search and filters; the status URL also survives reload, including Processing. Tabs expose selected state and support Left/Right, Home and End keyboard navigation. Monthly overview and Settings remain separate destinations. `public/minimal.css` defines the restrained white/gray shell, compact summary, inline upload controls and list surfaces; original storage and automatic filing are unchanged.

## Telegram feedback

Receipt acknowledgements use a short received/processing status and a View receipt button. Results emphasize merchant and amount, with date, meaningful category and filing status beneath. Review results state concrete exceptions. Receipt identifiers stay in the archive, and messages reply to their source upload for context. All dynamic receipt text is escaped for Telegram HTML. Successful filing results are silent; attention results notify normally.

## Tax-inclusive receipts and Trash

Recognition policy v2 rejects TOTAL-only evidence for subtotal and rejects tax registration IDs as monetary tax components. On save, previously machine-filled invalid fields are cleared using their retained evidence; manual edits remain protected. Existing pending receipts are reassessed once with an audit event. No additional model run is needed.

Move to Trash excludes an expense from normal lists, dashboard totals and bookkeeping exports. Settings → Trash allows restoration. Originals, recognition evidence and activity history remain intact. Deletion and restoration require the current record version. Schema 6 adds a nullable deleted_at column; take a verified snapshot before upgrading.

## Custom domain authentication

Cloudflare mode requires RECEIPTBOX_ACCESS_ISSUER and RECEIPTBOX_ACCESS_AUDIENCE, plus RECEIPTBOX_PUBLIC_ORIGIN for the domain. The primary loopback listener (4317) validates RS256 Access application JWTs, including issuer, audience, expiry and human identity. Access policies define the allowed users. Caller-supplied Tailscale identity headers are never accepted on this listener. Public signing keys are cached for five minutes; verification failures deny access.

The optional fallback runs on a distinct loopback port, RECEIPTBOX_TAILSCALE_PORT (4319), with RECEIPTBOX_TAILSCALE_ORIGIN and the existing RECEIPTBOX_ALLOWED_LOGIN identity. Tailscale Serve must forward its existing private URL to this fallback port; Cloudflare Tunnel must only forward to the primary port. Each listener validates its own Host and mutation Origin. Bot links use the new public origin. Do not configure a tunnel route to the fallback port.

## Human-readable exports

Individual downloads and ZIP originals use receipt date, merchant (or custom receipt name) and currency/amount; multiple files add a page suffix and colliding ZIP names add a numeric suffix. Original bytes remain unchanged. ZIP exports include Receipt details.html with saved receipt fields and relative original links, a human-labelled receipts.csv, unfinished.csv, summary.json and a manifest mapping filenames to internal records and hashes. Record identifiers remain audit metadata rather than the primary filename or first CSV column. No item-level values are invented; item details remain in the originals. Names are filesystem-safe and UTF-8 byte-bounded, HTML is escaped and CSV formula prefixes are neutralised.

Export UI offers all receipts, monthly/yearly presets, custom dates and an optional fiscal-year control. Dialog forms share compact typography, neutral surfaces and consistent controls.

## Projects

Projects groups trips or client engagements independently of expense category. The Projects dialog creates and renames projects, lists receipt counts and separate currency totals, and opens an exact project filter. Receipt details expose project assignment directly; exports have an independent project selector defaulting to the current archive project. Existing free-text project names are included automatically. Renaming updates all associated receipts, including Trash, within one transaction, increments versions and records each change in activity history. Empty projects can be removed; projects with any receipts must be reassigned first. Company-profile edits preserve managed projects. Telegram field replies such as `project: Toronto trip` remain supported.

## Telegram members

Settings → Members lets the owner create a single-use invitation valid for 24 hours, revoke unused invitations, and remove members. The recipient opens the link and confirms **Join company** in a private Telegram chat. The original paired account remains owner and cannot be removed. Members can upload and edit only receipts whose original upload event identifies their Telegram user ID. Duplicate uploads do not grant edit ownership. Removal preserves originals and upload history and stops new intake, edits, and result notifications to that member.

Set `RECEIPTBOX_OWNER_EMAIL` to the owner's Cloudflare Access login email. Member management checks the verified JWT email; it fails closed when this setting is missing. The existing owner-only Tailscale listener remains an administrative fallback. Telegram invitations do not grant website access. Invitations are stored as SHA-256 hashes in SQLite; the raw share link is returned only on creation. No invitation is sent automatically. Membership and invitation state are included in database snapshots; bot credentials remain separate.

## Duplicate confirmation

A match on normalized merchant, date, currency and amount now requires confirmation. The new original is retained and the receipt appears in Needs attention; it is excluded from Spending, project amounts and export summaries. Exported detail rows and originals remain available, labeled Pending duplicate confirmation. **Use existing** moves the new receipt to recoverable Trash; **Keep both** allows both amounts to count. Restoring an upload discarded as a duplicate requires confirmation again. Decisions are version-checked and audited; changing the matching fields can require a new decision. Telegram actions require an authorized sender, an owned receipt and a mapped bot message. Exact-file hash deduplication remains automatic.

Database schema 7 adds duplicate state. Before deployment, retain a verified snapshot and the previous release. An older release cannot open schema 7; a rollback must restore the pre-upgrade snapshot as well. No historical Telegram notifications are replayed.

Local recognition bounds evidence to short excerpts and uses a 4096-token output budget. Truncated output is rejected explicitly; worker failure logs contain job/attempt/error codes, never model text. Company configuration is not sent as extraction evidence.

Expense categories include Utilities, Rent & workspace, Repairs & maintenance, Advertising & marketing, Training & books, and Shipping & postage. Uncertain classification stays Unclassified without blocking filing. The local model stays warm for five minutes after use to reduce reloads for consecutive receipts.

Category recovery uses explicit human category corrections for an exact normalized merchant, excluding mixed retailers, trashed examples, and conflicting categories. BC Hydro/FortisBC have a utility-provider rule. Remaining uncertain categories get at most one local, text-only classification pass (30-second deadline); errors preserve the primary recognition result. Stored category evidence records the source. Existing filed receipts are not bulk reclassified.

Expenses offers Overview (time and category charts), Trends (day/month/year), Breakdown (category/project), and a sortable Table. Views share period/currency/project/category filters and drill into matching receipts. Download summary CSV exports the displayed grouping and filter context, with missing-tax counts. This summary is separate from the original-receipt archive.

## Report consistency and accessibility (0.3.24)

Report drill-through retains the duplicate exclusion filter, so receipt counts match the summary. Table sorting uses displayed names, preserves keyboard focus, and exposes the active direction with arrows and aria-sort. Only a short status message is a live region. Summary CSV follows table sorting and includes share and total rows; Overview exports both category and monthly sections.

## Telegram receipt cards (0.3.25)

Receipt results use a status icon and heading, merchant, a separate bold amount, and readable date/category metadata. Failed recognition is distinct from field review and links to the receipt for retry. Unknown merchants fall back to the receipt reference. Project names are included when set; all user content remains HTML-escaped. Filed results remain silent. Existing messages are not replayed.

## Telegram card lifecycle (0.3.26)

Results use a status heading, native HTML blockquote receipt card, and a clear action. Single missing fields include a reply template. Human titles and original filenames identify unread receipts; generated Telegram photo filenames and internal references are omitted. Exact-file acknowledgements show the existing receipt and status.

New acknowledgements are recorded in the additive telegram_cards table. Successful recognition edits its acknowledgement instead of sending a second message. Exceptions clear Reading from that acknowledgement and send a separate alert. Legacy acknowledgements keep their prior delivery behavior. Missing/uneditable messages fall back to sending; transient failures retain outbox retry; unchanged edits count as delivered. Duplicate decisions remove their action buttons after a successful edit. No old notifications are replayed. Card rendering was verified with formatting and mocked transport tests, not a live Telegram test message.

## Company currency fallback (0.3.27)

Recognition uses explicit currency evidence first and defaults missing currency to CAD. The model still reports unknown currency as unknown; policy records company_default separately from receipt evidence in the assessment and audit event. Saved currencies are preserved. Conflicting currency evidence or unsupported foreign currencies still require review. Existing unfinished ready results are reassessed once by the new policy without another model run or replaying notifications.

## Included-tax fuel sales (0.3.28)

A sales line equal to the total is rejected as a pre-tax subtotal when numeric evidence explicitly says tax is included. Printed pre-tax/subtotal lines and manually edited subtotals retain arithmetic checks. Historic model-filled subtotals are cleared by policy reassessment and by Save; total and included tax remain unchanged. Policy changes are audited without rerunning recognition or replaying notifications.

## Currency evidence provenance (0.3.29)

Currency detection prefers matching lines from independent on-device OCR, carried separately from model-generated JSON. Older results fall back to receipt excerpts, excluding commentary about assumptions, defaults, absent symbols and formats. An unsupported model guess alone no longer blocks the authorized CAD default. Explicit foreign evidence and real currency conflicts are retained. User-saved currencies are unchanged.

## UI system (0.3.30)

The archive uses one token-based stylesheet (`public/style.css`) across Receipts, Projects, Expenses, Settings and dialogs. Normal filed rows omit status badges; exceptions remain visible. Processing is shown as a status tab only when relevant. Receipt details prioritize the original and total, with names and optional fields under Edit details. Save keeps unresolved receipts open and closes successfully filed receipts. The zoom toolbar stays separate from the image scroll area. Mobile navigation and main actions use touch-sized targets, inputs use 16px text, and Settings keeps storage status visible.

Expenses retains Overview, Trends, Breakdown and Table, shared filters, keyboard sorting and matching receipt drill-through. UI verification uses disposable fictional receipts via `npm run qa`; it never loads production originals. Originals and recognition stay on the Mac mini.

## Visual refinement (0.3.31)

A cool gray canvas, white workspace, ink typography and restrained cobalt accents unify the interface. Reports emphasize the total, use lighter chart framing and compact segmented views, and retain exact amount labels and existing filters. Mobile filters stack their labels above touch-sized controls, including custom dates. No financial, recognition, storage or access policy changes are included.

## Local model and filing policy (0.3.32)

Image extraction and category retries use the shared Qwen3.5 4B configuration with thinking disabled. Apple Vision and all model processing remain on the host. Merchant is optional across recognition, manual filing, missing-field exports and form expansion; date, total and currency remain filing requirements, and financial/document conflicts still require review. Descriptive names fall back to category and date or an available filename, without inventing merchant facts. Existing saved names remain intact. Policy reassessment clears merchant-only exceptions on unfinished recognized receipts without rerunning recognition or replaying notifications.

## Subtotal evidence (0.3.33)

Model-extracted subtotal requires an explicit subtotal or pre-tax label. Current charges, balances and amount due are not pre-tax subtotals. Policy reassessment and Save remove unsupported model-filled subtotals while preserving human edits and genuine subtotal conflicts. The arithmetic Fix action opens subtotal and tip as well as total and tax, so all relevant fields are visible. Historical reassessment does not rerun models or replay bot messages.

## Health queue scope (0.3.34)

`/api/health` counts finished recognition outcomes (ready, failed, superseded) only for receipts outside Trash, so a failure on a deleted receipt no longer looks like an open problem. Queued and running jobs are always counted, including for trashed receipts, because Trash does not cancel recognition and deployments must still wait for that work to drain. No recognition, retry or storage behavior changes.

## Repository layout (0.3.35)

Source moved into `src/`, tests into `test/`, helper scripts into `scripts/`, Swift helpers into `native/` and design notes into `docs/`. Releases now contain runtime code only. **Existing installations must update their LaunchAgents** to run `current/src/server.mjs`, `current/src/worker.mjs` and `current/src/backup.mjs` when switching to a release built from this layout. No data or schema changes.

## Symlink-safe command entry points (0.3.36)

`src/backup.mjs`, `src/recovery.mjs`, `src/release.mjs` and `scripts/migration-check.mjs` decide whether they were started as a command by comparing real paths (`src/cli.mjs`). Previously the check compared the symlinked command path with the module's real path, so the daily snapshot LaunchAgent, which runs through the `current` release symlink, exited successfully without taking a snapshot. Snapshots taken by calling a release path directly were unaffected.

## Editorial interface (0.3.37)

The web app moves from layered gray cards to one warm paper surface separated by hairlines. Page titles, headline totals and receipt amounts use the system serif (New York on Apple devices, Georgia elsewhere), so no web fonts are loaded and the content security policy is unchanged. Status tabs and report views are underline tabs, filters are soft pills, the attention notice is a ruled line with a status dot, charts are monochrome with the accent reserved for hover and focus, and dialogs blur the page behind them. The page no longer scrolls behind an open dialog, time charts spread across the full width without widening bars, and the constant `projectExact` flag no longer appears in shareable URLs. No data, recognition or filing behavior changes.

## Ledger redesign (0.4.0)

The web app is restructured around how receipts are read back. A thin top bar replaces the sidebar with three destinations (Receipts, Spending, Settings); search and an add button live in the bar on every page, with ⌘K to search and drop-anywhere upload. Receipts opens on this month's CAD total with a twelve-month strip, then a "Needs a look" list naming what each exception lacks, then a ledger grouped by receipt month with per-month, per-currency totals for the receipts shown. Receipt details open in a right-hand drawer (a bottom sheet on phones) with the original first and the fields as an editable property list. Spending leads with one period total, fills every month of the selected range in the chart, and shows categories and projects side by side. Projects are managed from Settings. The Ledger theme uses pale green paper, dark green ink and monospaced figures (IBM Plex when installed, system fonts otherwise). Data, recognition, filing rules and APIs are unchanged.

## Default project label (0.4.1)

Receipts without a project are labelled "Default" instead of "No project" in the receipt drawer, Spending breakdowns, the summary table and summary CSV, and the filter chip. Stored data is unchanged: these receipts still have an empty project.

## Reserved Default project name (0.4.2)

"Default" (any case, surrounding spaces ignored) can no longer be used as a project name, because it labels receipts without a project. Creating or renaming a project to it, or setting it on a receipt from the web or a Telegram reply, is rejected with an explanation. Telegram replies that change nothing now state the actual reason instead of a generic date and amount hint.

## Fox logo (0.4.3)

The folded-receipt fox replaces the generic receipt icon as the brand mark, browser icon and home-screen icon (`public/logo-192.png`, `public/apple-touch-icon.png`). These two files are the only images the repository tracks. The empty receipt list now points to the + button and drop-anywhere upload instead of the removed upload card.
