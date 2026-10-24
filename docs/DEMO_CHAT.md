# 💬 Demo chat journeys — admin authoring (Phases 3C-2 / 3C-3)

Scripted, **simulated** 30-day chat journeys shown by DEMO competition profiles.
No AI, no WhatsApp/SMS, never a real affiliate balance, order, commission,
payout or notification. Phases 3C-2/3C-3 are **authoring only** (journeys, steps,
media library); Phase 3C-6 adds message materialization and Phase 3C-7 the affiliate
Mini Chat (dashboard card + API). Everything stays disabled by default: no profile is
assigned or enabled, and the card renders nothing until both gates are on.

## Data (migrations `20261023_demo_chat_journeys`, `20261024_demo_chat_audit_truncate_guard`)
| Table | Used for |
|---|---|
| `demo_chat_journeys` | journey header, status `draft` / `archived` |
| `demo_chat_journey_steps` | editable draft steps (day 1–30, `HH:MM` Casablanca) |
| `demo_chat_journey_versions` | immutable published snapshots (canonical steps + sha256) |
| `demo_chat_audit_log` | append-only trail (UPDATE/DELETE row trigger + TRUNCATE statement trigger) |
| `demo_chat_assets` | media library (3C-3): images + voice notes |
| `demo_chat_version_assets` | assets frozen into a published version (3C-3) |
| `demo_sim_day_coverage` + settings `demo-sim-participants:*` | simulation coverage evidence (3C-5) |
| assignments, messages, viewer states | not written yet |

## Gates — the chat stays OFF
Both are required (`src/lib/demoChatGate.js`):
1. server env `DEMO_CHAT_ENABLED=true` (`.env.example` ships `false`);
2. settings row `demo-chat-config` with `{ "enabled": true }` — reserved in
   `settingsController` so the generic `/api/setting` route cannot write it.

Phases 3C-2/3C-3 contain no code that writes the settings row and no route that enables
the chat. `/api/admin/demo-chat/status` only reports the state.

## Authoring rules (`src/lib/demoChatValidation.js`, mirrored by the DB CHECKs)
- Step types: `text`, `earnings`, `image`, `audio`. Media steps reference a library asset of the same
  kind (checked on create/update/publish) and may carry an optional caption (same text rules, no placeholders).
- Earnings: period `today` (only from 12:00 Casablanca) / `yesterday` / `week`;
  metric `commission` / `orders` / `revenue`. Placeholders **only** `{amount}`,
  `{orders}`, `{period}`; the metric's placeholder is required (`{orders}` for
  orders, `{amount}` otherwise). Values are filled from simulated demo data at
  display time (3C-3), never typed.
- Text steps carry no placeholders.
- **No hand-typed amounts or order counts in any step** (e.g. `250 MAD`, `MAD 300`, `١٥٠ درهم`, `12 commandes`, `5 طلبات`). Heuristic: spelled-out numbers are not detected.

## Workflow
- Every journey-scoped write sends `expectedUpdatedAt`; a mismatch is `409 STALE` (reload).
- Writes lock the journey row (`FOR UPDATE`) and run in one transaction with exactly one audit row.
- Archived journeys are read-only. A journey with versions cannot be deleted (archive it).
- **Publish** freezes the canonical draft as version N+1; an unchanged draft is `409 NO_CHANGES`.
  Versions have no update/delete path. Publishing assigns nothing.
- **Preview** (`POST /api/admin/demo-chat/preview`) writes nothing; earnings show labelled sample values.

## Media assets (Phase 3C-3)
Validated server-side from the **actual bytes** (`src/lib/demoChatMedia.js`); the client file name,
extension, MIME type and any claimed duration are ignored.

| | Images | Voice notes |
|---|---|---|
| Accepted input | JPEG, PNG, WEBP (magic bytes + full sharp decode; single frame; ≥ 16 px; ≤ 40 MP) | MP3 (MPEG Layer III), M4A (AAC in MP4), Ogg Opus / Vorbis |
| Max upload | 10 MB (= `uploadSecurity.IMAGE_MAX_BYTES`) | 5 MB (5 242 880 bytes) |
| Stored as | re-encoded WebP q82, ≤ 1600 px, EXIF orientation applied, **all metadata stripped** | **transcoded** AAC-LC in M4A (`audio/mp4`), mono 44.1 kHz 64 kb/s, metadata dropped — never the original upload |
| Duration | — | from the parsed stream (MP3: every frame walked; M4A: `mvhd`; Ogg: last granule, CRC-checked pages). **≤ 180 s**; no duration → rejected |
| Rejected | GIF, SVG, HTML/markup, HEIC, animated, corrupt/truncated, decompression bombs | WAV, video tracks, unsupported codecs, multiplexed/corrupt/truncated streams, trailing data |

- **ffprobe** (if installed; `FFPROBE_PATH` honoured, as in `videoValidation.js`) runs as an independent
  second check: it must agree on format, stream layout and duration (±max(1 s, 5 %)); the longer duration is
  enforced. Without ffprobe the JS parser alone decides (fail-closed). No new npm dependency.
  It runs **asynchronously** (`execFile`, no shell), is killed (SIGKILL) after 10 s, at most 2 run at once,
  the demuxer is **forced** to the detected format (`-f mp3|ogg|mov`) and only the local `file` protocol is
  allowed (`-protocol_whitelist file`); the temp file is created exclusively with mode 0600 and always removed.
  Availability is checked once per process.
- **Transcoding (mandatory)** — `src/lib/demoChatTranscode.js`. After the input checks above, every voice
  note is re-encoded by ffmpeg and only the output is kept; the output is re-validated from its bytes
  (M4A structure, AAC codec, no video, size < 3 MB, duration ≤ 180 s and within ±max(1 s, 5 %) of the
  input; ffprobe again when available). Any failure → rejected; **no fallback to the original**.
  - Executable: `FFMPEG_PATH` must be an **absolute** path to an executable whose `-version` starts with
    `ffmpeg version` and which lists the native `aac` encoder (verified once per process; no PATH lookup).
    Missing/invalid → `503 TRANSCODER_UNAVAILABLE` (voice notes disabled, images unaffected).
  - Invocation: `execFile`, fixed argv (no shell); forced input demuxer, `-protocol_whitelist file`,
    `-xerror -err_detect explode`, first audio stream only, `-map_metadata -1`, `-t 180`, `-fs 3 MB`,
    `-threads 1`, bitexact output. SIGKILL after 30 s (`TRANSCODE_TIMEOUT`), ≤ 2 concurrent, queue of 8
    (`503 TRANSCODER_BUSY` beyond), stderr logged server-side only.
  - Temp files: private `mkdtemp` dir (0700), input created exclusively (0600), dir removed in `finally`.
  - Note: a nominal 3:00 MP3 can measure slightly over 180 s (encoder padding) and is then rejected.
- **Upload size** — the route never calls `req.formData()` directly: `readFormDataWithLimit`
  (`src/lib/demoChatUpload.js`) counts bytes while reading the stream and aborts with 413 past
  10 MB + 256 KB, whether `Content-Length` is absent, understated or overstated; then the per-kind limit
  (image 10 MB / audio 5 MB) and the content checks apply.
- **Storage** — the shared facade `saveMedia` / `destroyByUrl` (`src/lib/cloudinary.js`), so the existing
  `MEDIA_STORAGE` / `R2_*` configuration applies unchanged:
  - R2: `<R2_PREFIX>/demo-chat-images/<uuid>.webp`, `<R2_PREFIX>/demo-chat-audio/<uuid>.<mp3|m4a|ogg>`
  - local (default): `public/uploads/demo/chat/images/…`, `public/uploads/demo/chat/audio/…`.
    The shared `destroyByUrl` never deletes local files, so demo chat uses `destroyDemoChatMedia`
    (`src/lib/demoChatStorage.js`): it deletes **only** `/uploads/demo/chat/images/<uuid v4>.webp` and
    `/uploads/demo/chat/audio/<uuid v4>.(mp3|m4a|ogg)` (no traversal, encoded segments, query strings,
    symlinks or symlinked folders) and delegates every other URL unchanged to `destroyByUrl`.
  - keys are random UUIDs + the detected extension — never the client file name; explicit
    Content-Type (`image/webp`, `audio/mpeg`, `audio/mp4`, `audio/ogg`) is sent to R2
    (`saveMedia` now forwards an optional `contentType`; other callers are unchanged).
- **Lifecycle** — identical content (sha256) returns the existing asset. Storage failure → 502, nothing
  written. DB/audit failure after storing → the object is deleted again; if that fails it is logged as an
  orphan with its key. Delete is refused (409) while any draft step, **published version** or message uses
  the asset; the row is removed first, then the object (a failed object delete is logged).
- **Gates** — media authoring is admin-only and, like journey authoring, works while the chat is disabled;
  nothing is exposed to affiliates (no affiliate-facing route exists yet).

### Security review decisions (Phase 3C-3)
- **Public URLs (accepted, documented).** Uploaded demo media is reachable by its URL like every other
  R2/`/uploads` file, even while the chat is disabled. URLs are unguessable (random UUID v4 keys, never
  listed publicly) and the content is admin-authored simulation media, not personal data. Making it private
  would need signed URLs or a proxy route — a new storage behaviour/config, deliberately not done. **Do not
  upload anything that must stay confidential.** R2 objects are served with
  `Cache-Control: public, max-age=31536000, immutable`, so a deleted file can stay in CDN/browser caches
  until it expires; `/uploads` responses carry the site-wide `X-Content-Type-Options: nosniff` + CSP.
- **Audio — mitigated by transcoding.** Parsing alone cannot prove a payload is benign (bytes hidden in MP3
  frames pass the parser, ffprobe and even a decode — verified). Every voice note is therefore re-encoded and
  only the fresh AAC/M4A output is stored (verified: hidden payloads, tags and encoder strings do not survive).
  **Remaining risk:** untrusted input is now decoded by ffmpeg *on the server*. It runs with a timeout, one
  thread, no network protocols and a forced demuxer, but **not in a sandbox** (no container/seccomp/rlimits):
  keep ffmpeg patched, and consider running it under a restricted user or container before wide use.
- **Races.** Delete locks the asset row (`FOR UPDATE`) and counts draft steps / version links / messages;
  concurrent step creation or publishing is blocked by the FK `RESTRICT` (a referencing insert must lock the
  asset row), so a referenced asset can never be removed. Each upload gets its own UUID key, so deleting one
  object never affects another upload of identical content. Remaining gap: a process crash **between**
  storing a file and inserting its row leaves an unrecorded object (no compensation can run); a future
  reconciliation job could list `demo-chat-*` objects without a row.

## Scheduling, date mapping and earnings (Phase 3C-4 — preview only)
Pure modules, `now` always injected: `src/lib/demoChatTime.js`, `src/lib/demoChatSchedule.js`,
`src/lib/demoChatEarnings.js`. Nothing is persisted yet (no assignment, no message, no scheduler job).

- **Time zone** — `Africa/Casablanca` via the runtime's Intl tz data; the process TZ is never read or set.
  Calendar days are `YYYY-MM-DD` keys with calendar arithmetic (local days of 23/25 h around Morocco's
  Ramadan offset change are handled). A skipped wall time runs at the first instant after the gap; a
  repeated one at the earlier instant (both flagged `timeAdjustment`).
- **Cycles** — day 1 = the assignment's anchor date (Casablanca). Cycle *n* covers anchor + 30n … + 29.
  Visible at `now` = current-cycle messages scheduled ≤ now, each at its own original Casablanca date/time:
  a late joiner sees day 1 … now; future messages never appear; earlier cycles are hidden (not deleted).
- **History buckets** — a `demo_earnings_history` row's day is its **UTC calendar date** (rows are written at
  server-local midnight; all stored rows are 00:00 UTC — Phase 3C-0). Casablanca date D ↔ bucket D, i.e. the
  bucket runs 01:00–01:00 Casablanca at UTC+1 (a documented ±1 h approximation). Non-midnight or duplicate
  rows make the day unavailable (fail-closed).
- **Day status** — `complete`: admin-edited / backfilled row, or row + coverage proving the whole bucket
  (`demo_sim_day_coverage`: first tick ≤ start + 5 min, last ≥ end − 5 min, max gap ≤ 5 min, profile existed
  all day), or **no row + that proof → 0**. `incomplete`: row without proof. `unavailable`: anything else.
  Only `complete` (and `provisional` today) values are rendered; otherwise the message shows
  « Données indisponibles » / « المعطيات … ماشي متوفرة » — **never 0**.
- **Periods** (relative to the message's own date D): `yesterday` = D−1 (must be finished at now);
  `week` = D−7 … D−1, unavailable unless all 7 days are complete; `today` = D only when D is today and
  ≥ 12:00 Casablanca, always suffixed « (provisoire) » / « (مؤقت) ». A `today` message viewed on a later day
  is unavailable (its send-time value is not recorded until messages are persisted).
- **Placeholders** — `{amount}` = commission (earnings, 5 % of the profile's demo revenue), or revenue when
  the step's metric is `revenue`; `{orders}` = order count; `{period}` = period label. Anything else → invalid.
- **Preview** — `POST /api/admin/demo-chat/preview/schedule` and the « Planning » panel on the preview page:
  journey/version + demo profile + day-1 date + Casablanca date/time (+ `ar`/`fr` labels). Reads only demo
  chat tables, the demo profile, its demo history, coverage and `demo-profile-meta:*`; writes nothing.
- **Coverage evidence (Phase 3C-5)** — `src/lib/demoSimCoverage.js`, recorded by every SUCCESSFUL
  `simulateTick()` (auto engine and manual button), after its history writes, in one transaction:
  - `demo_sim_day_coverage` (per UTC day): first/last tick, tick count, largest gap. Atomic
    `INSERT … ON CONFLICT DO UPDATE`; the gap only grows when a tick extends the range (later or earlier) and
    never shrinks, so duplicate, retried or late ticks can only make a day look *less* covered.
  - settings `demo-sim-participants:<YYYY-MM-DD>`: ids of the eligible profiles (active + stats) present in
    **every** tick that day (atomic intersection) — a profile activated/deactivated mid-day drops out.
    Reserved: the generic `/api/setting` route refuses it.
  - A day yields **0** only with full coverage **and** participation **and** the profile existing before the day.
  - Nothing is recorded when the server's local midnight is not UTC midnight (history buckets would disagree);
    the server TZ is never changed. Disabled or failed ticks record nothing; a recorder error is logged and
    the tick continues (the day simply stays unproven).
  - Manual ticks run under the engine's advisory lock (`DEMO_SIM_LOCK_KEY`, transaction-scoped) → 409 when busy;
    no more concurrent manual + engine ticks (and their duplicate history rows).
  - `clearCompetitionHistory()` deletes history, archives, coverage and participants in ONE transaction.
  - Backfill never fills a day that coverage proves was zero for that profile.
  - Coverage starts when this is deployed: earlier days stay unproven (curated rows still resolve).

## Message materialization (Phase 3C-6 — service only, disabled)
`src/lib/services/demoChatMessageService.js` writes `demo_chat_messages` rows for enabled assignments.
No schema change: it relies on the Phase 3C-1 unique key and `earningsSnapshot` column.

- **Gates** — runs only when env `DEMO_CHAT_ENABLED=true` **and** setting `demo-chat-config` `{enabled:true}`
  **and** the assignment is enabled. Otherwise it returns `skipped` and writes nothing. Since Phase 3C-7 the
  affiliate feed calls it lazily (see below); no scheduler job or PM2 change calls it, and no profile is
  enabled or assigned.
- **What is created** — the steps of the assignment's PUBLISHED version (immutable snapshot), scheduled by the
  Phase 3C-4 scheduler: current cycle only, `scheduledAt ≤ now`, each at its original Casablanca date/time.
  A late joiner gets day 1 … now of the current cycle; earlier cycles are never back-filled; future messages
  are never created.
- **Idempotent** — one row per `(assignmentId, revision, loopIndex, stepId)` (database unique key). Inserts use
  `createMany({ skipDuplicates: true })` (`INSERT … ON CONFLICT DO NOTHING`) inside a transaction that locks the
  assignment `FOR SHARE` and re-checks version / revision / anchor / enabled; if they changed, nothing is
  inserted and the next run uses the new state. Concurrent calls, retries and restarts cannot duplicate a
  message. Existing rows are never updated; a stored row whose version disagrees with the assignment is
  logged as a conflict and left untouched. `revision` stands for (version, anchor).
- **Earnings snapshot (immutable)** — the Phase 3C-4 resolver runs ONCE, at materialization; its result
  (`v: 1`, status, amounts only when `complete`/`provisional`) is stored in `earningsSnapshot` and is the only
  source when the message is shown — never re-resolved, so a historical message never changes. Unverified
  data is never shown as an amount: `incomplete`/`unavailable` are stored as such and render
  « Données indisponibles », never 0. A `today` summary materialized more than 15 min after its scheduled time
  is stored `unavailable` (`materialized_too_late`).
- **Audit** — each insert batch that creates rows adds one SYSTEM `MESSAGES_MATERIALIZE` audit row
  (`entityType: 'assignment'`).
- **View** — `listAssignmentMessages()` returns the current revision's current-cycle rows with
  `scheduledAt ≤ now`; earlier cycles are hidden (`previousCyclesHidden`), not deleted.
- **Retention** — nothing deletes messages; old-cycle rows stay until the agreed retention cleanup
  (a separate, approved procedure).
- **Limitations** — verified with a fake database only (no PostgreSQL run of the concurrency path);
  `materializeDue()` processes at most 500 enabled assignments per call, sequentially; a `yesterday`
  message whose previous day is not yet provable at materialization (e.g. scheduled 00:30) is stored
  unavailable for good; wiring a scheduler or admin route needs separate approval.

## Affiliate Mini Chat (Phase 3C-7)
`GET /api/affiliate/demo-chat` (`src/app/api/affiliate/demo-chat/route.js` → `src/lib/demoChatFeedRoute.js`
→ `src/lib/services/demoChatFeedService.js`) and the `DemoMiniChat` card on the affiliate dashboard, directly
above Live Activity (`src/components/DemoMiniChat.jsx`, helpers `src/lib/demoMiniChatView.js`).

- **Shared, server-selected feed** — journeys are assigned to DEMO profiles, never to real affiliates. The feed
  is one simulated timeline made of the enabled assignments of active demo profiles, identical for every viewer.
  These are explicitly simulated conversations, not private conversations of real affiliates. The endpoint
  accepts no profile / assignment / affiliate id (only `lang=ar|fr`; other parameters are ignored) and returns
  no database ids (profiles get opaque per-response keys).
- **Request order** — `withAffiliateAuth` (401) → rate limit 30 / min (429) → both gates (uniform 404, no chat
  data, no further reads) → the token's account must exist and be active (403; the only real-affiliate read is
  `select { isActive }`) → lazy materialization → feed. Responses are `Cache-Control: private, no-store`.
- **Lazy materialization** — on each such request, for the conversations of this feed only, the Phase 3C-6
  `materializeAssignment` creates the due messages (`scheduledAt ≤ now`, current cycle, original Casablanca
  time) before reading. It re-checks both gates and `assignment.enabled`, inserts with `INSERT … ON CONFLICT
  DO NOTHING` under the assignment `FOR SHARE` lock, never updates or deletes, and stores the earnings snapshot
  once — concurrent requests cannot duplicate a message. Bounded: at most 20 conversations, sequential, within a
  4 s wall-clock budget (the rest is read as stored); a failure is logged and the stored messages are still
  served. No scheduler, no viewer state (`demo_chat_viewer_states` is not written).
- **Payload** — newest 200 messages (`truncated` flag), chronological across conversations (ties keep each
  conversation's order), each with `localDate` / `localTime` in Casablanca, `simulated: true`, plus `today`
  (Casablanca) for day labels. Media: only `http(s)` or same-origin URLs, asset kind must match the message
  type, no storage key / hash / uploader; otherwise `media_unavailable`. Unsafe avatar URLs → initials.
- **Earnings** — text rendered server-side from the stored snapshot only (never re-resolved, never computed in
  the browser). `unavailable`, missing, corrupt (non-finite / negative values, inconsistent status) or
  unknown-version snapshots show the fixed « Données indisponibles » / « … ماشي متوفرة » sentence — never an
  amount, never 0. `provisional` is labelled.
- **UI** — permanent simulation disclosure (independent of the payload); loading skeleton (after 400 ms, so no
  flash while disabled), empty, error + retry (keeps the last good feed), disabled (401/403/404 → renders
  nothing, polling stops). Polls every 60 s while the tab is visible. AR (RTL) / FR (LTR) from the site
  language; times shown exactly as sent (no browser time-zone conversion); no client re-sorting; no raw HTML.
- **Limits / remaining risks**
  - Verified with in-memory fakes only (no PostgreSQL run of the concurrent path; no browser run — the feature
    is off and no development database is available).
  - Materialization runs on the request path: while enabled, the first viewer after a step's time pays its
    cost (bounded as above). A scheduler would remove that but is out of scope.
  - The rate limiter is in-memory and keyed by IP (existing helper), not per affiliate or across instances.
  - 20 conversations / 200 messages per response; no pagination, no unread markers.
  - A "today" earnings message first materialized > 15 min after its time is stored unavailable (3C-6 rule) —
    with lazy materialization this happens when nobody opens the feed around that time.

## Deployment prerequisites (voice notes)
1. Install ffmpeg (≥ 4, with the built-in `aac` encoder — present in standard builds; ffmpeg 6.1.1 verified in
   Development) on every server that handles admin uploads. ffprobe (same package) is optional but recommended.
2. Set `FFMPEG_PATH` to its **absolute** path (e.g. `/usr/bin/ffmpeg`) in the server environment and restart.
   `FFPROBE_PATH` is optional (default: `ffprobe` on PATH).
3. Check: uploading a voice note in `/admin/demo-chat/assets` succeeds; without these steps voice-note uploads
   return 503 and nothing is stored (images keep working). No other configuration changes.

## API
Admin (all `withAdminAuth`): `/api/admin/demo-chat/journeys` (GET, POST) · `/journeys/:id` (GET, PATCH, DELETE) ·
`/journeys/:id/steps` (POST, PATCH reorder) · `/journeys/:id/steps/:stepId` (PATCH, DELETE) ·
`/journeys/:id/publish` (POST) · `/journeys/:id/versions[/:versionId]` (GET) ·
`/preview` (POST) · `/audit` (GET) · `/status` (GET) ·
`/assets` (GET, POST multipart `kind` + `file`) · `/assets/:id` (DELETE).
Affiliate (`withAffiliateAuth`, gated): `/api/affiliate/demo-chat` (GET).

## Audit log — limits
- Insert-only from the application; no source file updates/deletes it (enforced by `scripts/demoChat.test.mjs`).
- The database rejects UPDATE/DELETE (row trigger) and TRUNCATE (statement trigger) with PostgreSQL `P0001`.
  Prisma surfaces it as `PrismaClientUnknownRequestError` (or `P2010` for raw SQL); `src/lib/demoChatErrors.js`
  maps both to `500 AUDIT_APPEND_ONLY` and logs loudly — reaching it means a bug.
- Not protected against the table owner / a superuser (drop or disable triggers, `session_replication_role`,
  `DROP TABLE`, schema resets). Retention purges need their own approved procedure.

## Tests
`node scripts/demoChat.test.mjs`, `node scripts/demoChatMedia.test.mjs`,
`node scripts/demoChatMessages.test.mjs` and `node scripts/demoChatFeed.test.mjs` (no database, no network,
injected ffprobe). The SQL constraints, foreign keys and triggers were verified
separately against a temporary PostgreSQL 16 instance in Phase 3C-1 (TRUNCATE guard: static checks only).
