# UGC Affiliate Video Module — Implementation Report

## Project status

| | |
|---|---|
| **Feature Complete** | ✅ yes |
| **Code Complete** | ✅ yes — code review concluded and approved |
| **UI Redesigned** | ✅ yes — affiliate UGC tab, presentation-only (§14) |
| **Staging** | ⏳ **PENDING** — not executed |
| **Production** | ⏳ **VALIDATION PENDING** |

522 test assertions green; `npx next build` clean. All tests run against in-memory fakes —
**nothing has ever run against PostgreSQL.** Nothing committed or pushed; neither migration
applied. No further features are to be added before deployment; the remaining work is
operational validation only (§13).

**Date:** 2026-07-21

---

## 1. What this module does

Affiliates upload a short video promoting a product. An admin reviews it. Once a video is
**RUNNING**, a background engine generates *virtual* sales for it on a schedule, and each
generated batch credits the affiliate's withdrawable balance.

**Hard rule honoured throughout:** the engine never creates orders, inventory movements,
checkouts, or payments. It writes rows to its own ledger only. Nothing in the existing order
or checkout path was modified.

---

## 2. Architecture at a glance

```
 Affiliate UI ─┐                                    ┌─ Admin UI
 (dashboard    │                                    │  (review queue,
  tab)         ▼                                    ▼   settings)
        /api/affiliate/ugc/*                /api/admin/ugc-*
                 │                                   │
                 └──────────► ugcRouteHandlers ◄──────┘   (DI, testable)
                                    │
                                    ▼
                               ugcService          ← ALL authorization + rules
                        (state machine, storage,     live here, never in routes
                         history, concurrency)
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
      ugcStatus (FSM)      ugcEarningsService        ugcNotifications
                            (Decimal ledger)         (event-driven)
                                    │
                                    ▼
                          balance provider registry
                        (composes the affiliate balance)
                                    ▲
                                    │
                    ugcEngine ──────┘   ← standalone process
              (advisory lock, dry-run, cycles)
```

### Key design decisions

| Decision | Why |
|---|---|
| Authorization in the **service**, not routes | Any caller (route, job, script) is safe by construction. |
| Balance **derived** from providers, never incremented | No drift, no double-credit; balance is a pure function of the ledgers. |
| `Prisma.Decimal` for all money | Exact `NUMERIC(18,2)` math; no float error. |
| Ledger **append-only** + unique idempotency key | Exactly-once earnings, enforced by the database. |
| Delete **not implemented** | Submissions are permanent; affiliates replace instead. RESTRICT FKs make history unfalsifiable. |
| Engine is a **separate process** | A generation cycle can never block a web request. |
| Audit/notification writes are **non-fatal** | A logging failure must never roll back money or a submission. |

---

## 3. The money path

### Earning generation
1. The engine acquires a PostgreSQL **session advisory lock** (one runner at a time).
2. It **re-validates settings every cycle**. Disabled → quiet no-op. *Invalid* → abort as a failure and generate nothing.
3. It selects **only `RUNNING`** submissions.
4. It computes one **deterministic period** for the cycle: the UTC calendar day.
5. Per video, isolated in its own `try/catch`, it calls `recordUgcEarning`.

### Exactly-once guarantee
`idempotencyKey = "{ugcVideoId}:{generationPeriod}"` is `UNIQUE`. Three independent layers:

- **Advisory lock** — avoids concurrent runners (optimization).
- **Single atomic INSERT** — a crash commits all or nothing.
- **Unique constraint** — the actual correctness guarantee. A duplicate raises `P2002`, which is
  reported as an *expected* `duplicate_suppressed` event, never an error.

Because correctness rests on the constraint rather than the lock, losing the lock mid-cycle
cannot cause a double payout.

### ⚠️ Generation-period contract
> **Exactly one earning per RUNNING video per UTC calendar day.**
>
> The period string is part of the unique key, so this is enforced in the database.
> **Changing the granularity (e.g. hourly) or the timezone is a MONEY-PATH MIGRATION, not a
> config change** — it creates a new key space and can re-open already-settled periods for a
> second payout. `UGC_GRANULARITY.DAILY` is intentionally hardcoded in the engine.

### Balance composition
`getAffiliateBalance` was refactored to compose registered providers, ordered by priority:

| Priority | Source | Sign |
|---|---|---|
| 10 | `referral_commission` | + |
| 20 | `referral_bonus` | + |
| 30 | `payout_deduction` | − |
| 40 | `ugc_earning` | + |

**Non-regression was proved before the switch:** `balanceEquivalence.test.mjs` fuzzes 55 000+
money triples and asserts that, for an affiliate with no UGC records, the legacy arithmetic and
the new registry composition are *exactly* equal.

---

## 4. State machine

Six legal edges, each with an actor allow-list — arbitrary status writes are impossible.

```
PENDING  ──approve──►  APPROVED        (admin)
PENDING  ──reject───►  REJECTED        (admin, reason REQUIRED)
APPROVED ──start────►  RUNNING         (admin)
RUNNING  ──pause────►  PAUSED          (affiliate or admin)
PAUSED   ──resume───►  RUNNING         (affiliate or admin)
REJECTED ──replace──►  PENDING         (affiliate, via video replacement)
```

Only **RUNNING** earns. "Approve straight to running" composes two legal edges rather than
adding a seventh.

**Operational idempotency:** a repeated command that finds the submission already in the target
status returns the unchanged row — no DB write, no history entry — provided that actor could
legitimately reach that status. Otherwise it is a `409`, not a silent success.

### Orchestrated approval — where `defaultApprovedStatus` takes effect

`approveSubmission()` is the single place the setting is consumed. There is deliberately **no**
`PENDING → RUNNING` edge; when the setting is `RUNNING`, approval **composes two legal edges**:

```
PENDING ──approve──► APPROVED ──start──► RUNNING
```

Each edge is asserted, guarded and audited separately, so **the history contains both transitions
as distinct rows** (verified by test) and each emits its own notification. With
`defaultApprovedStatus = APPROVED` the submission stops at APPROVED for a manual start — exactly
one transition row. The setting therefore has a real, observable effect; it is not decorative.

If the second edge fails (e.g. a concurrent change), the approval still stands and the approved
state is returned.

---

## 5. Safety properties

**Storage** — validate → upload → DB write. A failed DB write removes the just-uploaded object;
a failed upload writes no row. On replace, the old object is deleted **only after commit**.

**Concurrency** — create relies on `@@unique(affiliateId, productId)`. Replace and transition use
a guarded `updateMany` pinning the row's `updatedAt` (optimistic version token), so only one of
two racing requests commits; the loser removes its own upload.

**History** — append-only *and* idempotent: a history row is written only inside the same
transaction as a guarded update that actually changed something (`count === 1`). Retries append
nothing.

**Uploads** — Content-Length pre-check, then `File.size` checked *before* `arrayBuffer()`, then a
hard route ceiling.
> **Documented limitation:** this is **not** fully streaming. Next's `request.formData()` parses
> the whole body into memory before these guards run; they prevent a *second* oversized copy, not
> the initial parse. Only the Content-Length check can reject pre-parse, and only when the client
> is honest. *Future:* presigned direct-to-storage upload or a streaming multipart parser.

**Text** — all instructions/informational settings are bounded plain text: control characters
stripped, whitespace collapsed, length-capped, never rendered as HTML.

**Advisory lock** — on connection drop or query error the adapter fails **closed** (`acquire()`
returns `false`, so the cycle is skipped and nothing is generated without a valid lock) and
reconnects a fresh session before the next cycle.

---

## 6. Notifications (event-driven)

Emitted **after commit**, fire-and-forget, and they can never roll back or block the operation
that triggered them.

| Event | Affiliate | Admin |
|---|---|---|
| submission received / replaced | ✅ | ✅ "awaiting review" |
| approved | ✅ | — |
| running | ✅ | — |
| paused | ✅ | — |
| rejected (with reason) | ✅ | — |

Admin notifications surface as an unread "à réviser" badge in the review queue that jumps to the
PENDING filter and marks them read.

### Idempotency

Each notification carries a deterministic key backed by a **`UNIQUE` index** on `eventKey`:

```
ugc:{submissionId}:{historyId}:{eventType}:{audience}
```

Because every committed state change writes exactly one (append-only, idempotent) history row,
`historyId` identifies "this change happened once". A retry or duplicate service call rebuilds the
same key and collides — the insert is suppressed as an *expected duplicate*, not counted as a
failure. Including `historyId` is what makes repeated **pause → resume → pause** cycles safe: each
cycle has its own history row and therefore its own key, so later cycles still notify. Keying on
`submissionId + eventType` alone would have wrongly swallowed the second pause.

`eventKey` is nullable; existing/other notifications leave it `NULL`, and PostgreSQL permits
unlimited NULLs under a unique index.

## 6b. Operational visibility (`ugcOps`)

Audit and notification writes stay non-fatal — but never invisible. Every swallowed failure:

1. **increments a counter** per operation (with last error + timestamp),
2. **emits a structured, schema-versioned event** (`component:"ugc-ops"`, `severity:"error"`,
   `degraded:true`, plus context such as `earningsAffecting`),
3. **fans out to registered observers** via `onUgcOpsEvent()` — the seam for a metrics/APM backend
   (StatsD, OpenTelemetry, Sentry). A throwing observer can never break the caller.

`GET /api/admin/ugc-health` exposes the counters and recent events, returning **503** when
`totalFailures > 0`.

> ⚠️ Counters are in-process and reset on restart; with several PM2 instances each reports only
> its own. Treat the endpoint as "is something wrong right now" and alert on the structured log
> lines for the durable signal.

---

## 7. Settings audit trail

Every settings save appends an immutable `{key, from, to}` diff with the acting admin and
timestamp. Changes touching **earnings-affecting keys** are flagged and highlighted in the UI:

`enabled` · `earningsEngineEnabled` · `commissionPerSale` · `minGeneratedSales` ·
`maxGeneratedSales` · `generationSpeed` · `pollIntervalMs` · `defaultApprovedStatus`

Display-only knobs (estimates, instructions, video limits) are recorded but not flagged.
Normalization runs before diffing, so `"4"` → `4` is not a spurious change.

**Internal admin notes remain attached to state transitions only** — deliberately not
standalone-editable, so the audit trail stays meaningful.

---

## 8. User interfaces

### Affiliate — dashboard tab (self-contained `UgcTab.jsx`, 3-line diff to the existing page)
- Earnings stats (total/today earnings and generated sales).
- Intro: commission, plain-text instructions, example video, and an **explicitly labelled
  estimate** with a "not guaranteed income" disclaimer.
- Submission **wizard**: Produit → Vidéo → Aperçu → Envoi, with an in-browser preview showing
  filename, size, duration and a canvas-captured thumbnail before submitting.
- Submission list with a **status timeline** (Soumise → Approuvée → Diffusion, with rejected and
  paused branches), plus pause/resume and replace.
- Replace asks for confirmation first (it sends the video back through review).
- Optimistic UI with background refresh — never a full dashboard reload.

### Admin
- **Review queue**: status filters, pagination, search, freshness indicator with manual and
  1-minute auto refresh, per-row approve/reject/start/pause/resume, reject dialog enforcing a
  reason plus an optional internal note, and a detail drawer with the video, upload date,
  duration, file size, playback-speed control, fullscreen, and full status history.
- **Bulk actions: Start and Pause only.** Approve and reject are intentionally *not* bulk-able —
  each video must be watched and a rejection needs its own reason; bulk approval would let an
  unreviewed video start earning money.
- **Settings editor**: grouped, friendly units (Mo, minutes), client-side mirror of the server
  rules, an explicit warning on the earnings-engine toggle, and the settings change history.

---

## 9. Test coverage

Zero-dependency Node tests — `node scripts/<name>.test.mjs`.

| Suite | Assertions | Covers |
|---|---:|---|
| `ugcStatus` | 40 | state machine, actor permissions, idempotent reachability |
| `ugcSettings` | 48 | defaults, validation, plain-text bounds, interval clamping |
| `ugcEarnings` | 39 | periods, idempotency keys, Decimal amounts |
| `ugcVideoValidation` | 26 | MP4/MOV parsing, duration/codec policy |
| `ugcRefinements` | 53 | registry priority, log schema, structured results |
| `balanceEquivalence` | 7 | legacy vs registry balance equality (55k+ fuzzed) |
| `ugcService` | 63 | lifecycle, rollback, authorization, concurrency, notifications |
| `ugcRouteHandlers` | 55 | identity from session, error mapping, note stripping, audit |
| `ugcUpload` | 13 | pre-buffer size/type guards |
| `ugcEngine` | 44 | lock skip, settings gate, RUNNING-only, isolation, dry-run |
| `ugcAdvisoryLock` | 19 | fail-closed on drop, reconnect before next cycle |
| `ugcAuditNotify` | 40 | settings diff, earnings flagging, notification events |
| `ugcFinalChecks` | 35 | two-edge approval history, dedup keys, ops observability |
| `routeAuth` (systemic) | 35 | every write route is auth-wrapped |
| **Total** | **522** | all green |

`npx next build` compiles cleanly.

> **⚠️ What these tests do NOT prove.** Every suite above runs against in-memory fakes. No
> assertion here has touched PostgreSQL. Specifically unverified until staging: that the
> migrations apply, that the `UNIQUE(eventKey)` indexes behave as assumed on real data, that
> Decimal round-trips through `NUMERIC(18,2)` exactly, that the advisory lock works across real
> connections, and that the balance composition matches on production-shaped rows.
> `scripts/ugcBalanceRegression.harness.mjs` exists for that and needs a real `DATABASE_URL`;
> **it has not been run.**

---

## 10. Deployment runbook

Neither migration has been applied. **Both are additive** — they only `CREATE TYPE` / `CREATE TABLE`
and touch no existing column, constraint, or index.

1. **Back up the database.**
2. Apply migrations:
   - `20260720_ugc_module` — enum + 3 tables (submissions, history, earnings).
   - `20260721_ugc_audit_notifications` — settings history + admin notifications.
   Both are now archived unchanged in `prisma/migrations_archive/`; since Phase 3C-9A the active chain is
   the squashed `20261025000000_baseline`, which contains these tables (see `prisma/migrations/README.md`).
   - **Fresh (empty) database:** `npx prisma migrate deploy`.
   - **Existing database:** do NOT run the baseline; baseline it once with
     `npx prisma migrate resolve --applied 20261025000000_baseline` after an approved read-only
     schema/history comparison (procedure in that README). No database has been baselined by the repository.
3. `npx prisma generate` and redeploy the web app.
4. The module ships **off**: `enabled` and `earningsEngineEnabled` both default to `false`.
   Nothing is visible and nothing generates until an admin opts in.
5. Configure at **/admin/ugc-settings**, then enable the module.
6. Start the engine as its own process (e.g. a dedicated PM2 app):
   ```
   node scripts/ugc-earnings-engine.mjs --dry-run --once   # verify first: writes nothing
   node scripts/ugc-earnings-engine.mjs                    # then run for real
   ```
   Flags: `--once`, `--dry-run`, `--interval=<ms>` (clamped to the 60 s floor).
   It shuts down gracefully on SIGINT/SIGTERM, draining the in-flight cycle.
7. Only then enable **earningsEngineEnabled**.

**Rollback:** set `enabled=false` (hides the module) or `earningsEngineEnabled=false` (stops
generation) — both take effect on the next cycle, no deploy needed. The tables can stay; they are
inert when the module is off.

**Ordering note:** the app tolerates the second migration being absent — audit and notification
writes fail silently by design — but the first migration is required for the module to function.

---

## 11. Files

**New library modules** — `ugcStatus`, `ugcSettings`, `ugcEarnings`, `ugcCycleLog`, `ugcHttp`,
`ugcUpload`, `ugcVideoValidation`, `videoValidation`, `ugcRouteHandlers`, `ugcEngine`,
`ugcAdvisoryLock`, `ugcNotifications`, `ugcSettingsAudit`, `balance/composeBalance`,
`balance/providerRegistry`.

**New services** — `ugcService`, `ugcEarningsService`, `ugcAuditService`, `adminNotificationService`.

**New API routes** — 3 affiliate (`/api/affiliate/ugc`, `/[id]`, `/settings`), 4 admin
(`/api/admin/ugc-videos`, `/[id]`, `/ugc-settings`, `/ugc-notifications`).

**New UI** — `affiliate/dashboard/UgcTab.jsx`, `admin/ugc-videos/page.jsx`,
`admin/ugc-settings/page.jsx`.

**Modified (4 files, all minimally)** — `prisma/schema.prisma` (additive models only),
`affiliate/dashboard/page.jsx` (import + tab entry + render line), `admin/SideBar.jsx`
(two nav entries), `affiliateSystemService.js` (balance composition + provider registration).

---

## 12. Known limitations / follow-ups

1. **Multipart is not streaming** (§5). Revisit with presigned direct-to-storage uploads if larger
   files are needed.
2. **Engine wiring is temporary** — `ugcEarningsService` is imported from `affiliateSystemService`
   to register its balance provider. A dedicated bootstrap module would be cleaner (`TODO` in code).
3. **No DB-level verification has been run** in this environment. The balance regression harness
   should be run against a staging database before production.
4. **Video duration/size are not persisted** — the admin drawer derives them client-side (size via
   a `HEAD` request, which shows "—" if CORS blocks it). Persisting them at upload time would need
   a schema addition.
5. **Admin notifications are UGC-scoped** in the UI (a badge on the review queue). The table is
   generic if a global admin bell is wanted later.
6. **Three UI slots are laid out but have no data source** (see §14). The affiliate tab reserves
   space for 7-day earnings, per-video statistics and a performance trend; all three render neutral
   placeholders because the API cannot supply them. Filling them requires backend work that is
   **explicitly out of scope for now**:
   - *7-day earnings* — `getUgcStats` aggregates only "today" and "all time"; a third windowed
     aggregate would be needed.
   - *Per-video statistics* — `ugc_earnings` rows already carry `ugcVideoId`, so a
     `groupBy(ugcVideoId)` aggregate could supply per-video orders/earnings without a schema change.
   - *Performance trend* — needs the current window compared against the preceding one; only then
     can a real arrow replace "pas encore assez de données".

---

## 13. Staging verification — ⛔ PENDING (NOT EXECUTED)

**No step below has been performed.** This environment has **no `DATABASE_URL`** (only
`.env.example`), no staging access and no deployment capability, so none of it *could* be executed
here. Nothing may be described as production-validated until every box is ticked against a real
PostgreSQL database by someone with staging access.

| # | Required check | Status |
|---|---|---|
| 1 | **Database backup** | ☐ not done |
| 2 | **Apply both migrations** — `20260720_ugc_module`, then `20260721_ugc_audit_notifications` | ☐ not done |
| 3 | **`prisma generate`** on the target | ☐ not done |
| 4 | **Deployment** of the web app | ☐ not done |
| 5 | **Balance regression harness** — `scripts/ugcBalanceRegression.harness.mjs` | ☐ not done |
| 6 | **Complete workflow verification** — create / replace / approve / start / pause / resume / reject | ☐ not done |
| 7 | **Engine dry-run** — `node scripts/ugc-earnings-engine.mjs --dry-run --once` | ☐ not done |
| 8 | **Engine runtime verification** — normal run with earnings **disabled** | ☐ not done |
| 9 | **Duplicate suppression verification** — re-run the same UTC period | ☐ not done |
| 10 | **Audit verification** — settings history + earnings-affecting flag | ☐ not done |
| 11 | **Notification verification** — affiliate + admin events, dedup behaviour | ☐ not done |
| 12 | Enable earnings **only after checks 1–11 pass** | ☐ not done |

### Pass criteria for each check

- **5 — balance harness.** Old == new balance **exactly** for every affiliate with no UGC records.
  Any discrepancy is a stop-the-line defect.
- **6 — workflow.** Every transition succeeds and writes exactly one history row. Critically: with
  `defaultApprovedStatus = RUNNING`, one approve click must produce **two** history rows
  (`PENDING→APPROVED`, `APPROVED→RUNNING`). One row means the orchestration is not wired. Replace
  must return a rejected/pending submission to `PENDING` and delete the old object only after
  commit. Reject without a reason must be refused.
- **7 — engine dry-run.** Logs `outcome:"dry_run"`, writes **zero** rows to `ugc_earnings`.
  Confirm the table is still empty afterwards.
- **8 — engine runtime (earnings disabled).** Logs `outcome:"disabled"` and generates nothing,
  while proving the advisory lock, the poll loop and graceful SIGTERM shutdown all work against a
  real connection.
- **9 — duplicate suppression.** After the first live cycle, immediately re-run it for the same UTC
  day: it must log `duplicate_suppressed` and create **no** second `ugc_earnings` row. This is the
  single most important money-safety check.
- **10 — audit.** Changing `commissionPerSale` appends a `ugc_settings_history` row flagged
  `earningsAffecting: true` with the correct `{key, from, to}` diff and acting admin.
- **11 — notifications.** Pause → resume → pause must yield **three** affiliate notifications
  (proves the `historyId` component of the dedup key). Re-issuing the *same* command must yield
  **no** extra row. A new submission must produce both an affiliate and an admin notification.
  Throughout, `GET /api/admin/ugc-health` must return `healthy: true` — a 503 means an
  audit/notification write is failing silently.
- **12 — enabling earnings.** Watch the first live cycle end-to-end: exactly one `ugc_earnings` row
  per RUNNING video, amount == `generatedSales × commissionPerSale`, and the affiliate's balance
  increasing by precisely that amount.

### Rollback at any point

Set `earningsEngineEnabled = false` (stops generation) or `enabled = false` (hides the module).
Both take effect on the next cycle with no deploy. The tables are inert when the module is off.

---

## 14. Affiliate UI redesign (presentation-only)

The affiliate UGC tab (`src/app/affiliate/dashboard/UgcTab.jsx`) was redesigned mobile-first to a
premium card layout. **One file changed.** No database, Prisma, API, service, route, permission,
affiliate-calculation or earnings-engine change; the six `fetch` calls are byte-identical to before.

**Delivered:** 2×2 rounded stat cards with tinted icon tiles; vertical 9:16 video cards with a
centred play button, real duration (read from the file's own metadata), status pill, product row
with an external link to `/products/{id}`; an HTML5 `<video>` **modal** player with
`controlsList="nodownload"` replacing the previous anchor that navigated to the raw file; a
full-width premium upload CTA opening the **existing** wizard in a sheet; violet/emerald/orange/rose
palette, soft shadows, generous spacing.

**Preserved unchanged:** upload wizard (steps, validation, endpoint), pause, resume, replace,
replace confirmation, optimistic updates + background refresh, estimate disclaimer, instructions,
example video, status timeline.

**Deliberately not added** (would have been new functionality, not restyling): bottom navigation
bar, header notification bell, extra statistics, new pages/tabs/buttons/workflows.

**Honest placeholders** — never fabricated, never computed client-side (see §12.6):

| Reference field | API reality | Rendered as |
|---|---|---|
| 7-day earnings | not exposed | "Données bientôt disponibles" |
| Per-video today / 7d / all-time | submissions carry no earnings data | 3-column layout, values `—` |
| Trend % vs previous period | no comparison data | "pas encore assez de données", no arrow |

This redesign does **not** affect the staging/production status: it is UI only and still requires
the §13 validation before production.
