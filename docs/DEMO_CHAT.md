# 💬 Demo chat journeys — admin authoring (Phase 3C-2)

Scripted, **simulated** 30-day chat journeys shown by DEMO competition profiles.
No AI, no WhatsApp/SMS, never a real affiliate balance, order, commission,
payout or notification. Phase 3C-2 is **authoring only**: journeys are not
assigned to profiles and the chat is not shown anywhere.

## Data (migrations `20261023_demo_chat_journeys`, `20261024_demo_chat_audit_truncate_guard`)
| Table | Used in 3C-2 for |
|---|---|
| `demo_chat_journeys` | journey header, status `draft` / `archived` |
| `demo_chat_journey_steps` | editable draft steps (day 1–30, `HH:MM` Casablanca) |
| `demo_chat_journey_versions` | immutable published snapshots (canonical steps + sha256) |
| `demo_chat_audit_log` | append-only trail (UPDATE/DELETE row trigger + TRUNCATE statement trigger) |
| assets, assignments, messages, viewer states, coverage | not written in 3C-2 |

## Gates — the chat stays OFF
Both are required (`src/lib/demoChatGate.js`):
1. server env `DEMO_CHAT_ENABLED=true` (`.env.example` ships `false`);
2. settings row `demo-chat-config` with `{ "enabled": true }` — reserved in
   `settingsController` so the generic `/api/setting` route cannot write it.

3C-2 contains no code that writes the settings row and no route that enables
the chat. `/api/admin/demo-chat/status` only reports the state.

## Authoring rules (`src/lib/demoChatValidation.js`, mirrored by the DB CHECKs)
- Step types: `text`, `earnings`. **Image/audio are deferred to 3C-3** (asset upload + duration check).
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

## API (all `withAdminAuth`)
`/api/admin/demo-chat/journeys` (GET, POST) · `/journeys/:id` (GET, PATCH, DELETE) ·
`/journeys/:id/steps` (POST, PATCH reorder) · `/journeys/:id/steps/:stepId` (PATCH, DELETE) ·
`/journeys/:id/publish` (POST) · `/journeys/:id/versions[/:versionId]` (GET) ·
`/preview` (POST) · `/audit` (GET) · `/status` (GET).

## Audit log — limits
- Insert-only from the application; no source file updates/deletes it (enforced by `scripts/demoChat.test.mjs`).
- The database rejects UPDATE/DELETE (row trigger) and TRUNCATE (statement trigger) with PostgreSQL `P0001`.
  Prisma surfaces it as `PrismaClientUnknownRequestError` (or `P2010` for raw SQL); `src/lib/demoChatErrors.js`
  maps both to `500 AUDIT_APPEND_ONLY` and logs loudly — reaching it means a bug.
- Not protected against the table owner / a superuser (drop or disable triggers, `session_replication_role`,
  `DROP TABLE`, schema resets). Retention purges need their own approved procedure.

## Tests
`node scripts/demoChat.test.mjs` (no database). The SQL constraints, foreign keys and triggers were verified
separately against a temporary PostgreSQL 16 instance in Phase 3C-1 (TRUNCATE guard: static checks only).
