# Prisma migrations — squashed baseline (Phase 3C-9A)

The active migration folder holds **one** migration:

| Migration | Purpose |
|---|---|
| `20261025000000_baseline` | Complete schema of `prisma/schema.prisma` + every SQL object Prisma cannot express |

New migrations are added after it as usual (`YYYYMMDDHHMMSS_name`, sorting after the baseline).

## Why the old migrations are archived

The 28 historical migrations (`20260316…` → `20261024…`) are kept **unchanged, byte for byte** in
`prisma/migrations_archive/` as a historical record. Prisma never reads that folder. They could not
build an empty database:

- **24 schema tables are created by no migration** (e.g. `affiliate_orders`, `demo_affiliates`, `gifts`,
  `demo_settings`, `affiliate_notifications`): the existing database was partly built with `prisma db push`.
- **Ordering defects:** `20260316214921_phase1…`, `20260316_add_content_items` and
  `20260316_add_posts_images` sort before `20260316_init` (`'2' < '_'`) although they depend on it;
  `20260423_abandoned_cart_orderid` sorts before `20260423_add_abandoned_carts`.
- The four oldest migrations are not idempotent (plain `CREATE TABLE` / `CREATE INDEX`).

Rewriting or renaming applied migrations would change their names/checksums in existing databases'
`_prisma_migrations`, so the chain was squashed instead (Prisma's documented "squash + baseline" approach).

## Fresh (empty) database

```
DATABASE_URL=<empty database> npx prisma migrate deploy
```

This creates all tables, enums, indexes, foreign keys and the custom objects below. Verified in Phase
3C-9A on a throwaway local PostgreSQL 16 (unix socket only): 78 tables, all custom objects present,
append-only and TRUNCATE protections reject mutations, `prisma migrate status` clean.

## Custom SQL objects (not expressible in `schema.prisma`)

All copied verbatim from the archived migrations into section 2 of the baseline:

| Object | Origin |
|---|---|
| Partial unique index `collections_slug_key` (`WHERE "slug" IS NOT NULL`) — replaces Prisma's plain `@unique` index of the same name | `20260316_init` |
| Expression index `products_title_key_idx` (`lower(btrim("title"))`) | `20260717_duplicate_detector` |
| Partial expression indexes `products_sku_key_idx`, `products_barcode_key_idx` | `20260717_duplicate_detector` |
| Partial unique index `affiliate_security_deposits_one_pending` (`WHERE "status" = 'PENDING'`) | `20260727_affiliate_security_deposit` |
| CHECKs `reward_gifts_values_check`, `reward_points_ledger_values_check`, `reward_order_awards_values_check`, `reward_redemptions_values_check`, `reward_redemption_history_values_check` | `20261019_affiliate_rewards` |
| Function `reward_reject_mutation()`; triggers `reward_points_ledger_append_only`, `reward_redemption_history_append_only` (UPDATE/DELETE rejected) | `20261019_affiliate_rewards` |
| CHECKs `demo_chat_journeys_values_check`, `demo_chat_journey_steps_values_check`, `demo_chat_journey_steps_shape_check`, `demo_chat_journey_versions_values_check`, `demo_chat_assets_values_check`, `demo_chat_assignments_values_check`, `demo_chat_messages_values_check`, `demo_chat_audit_log_values_check`, `demo_sim_day_coverage_values_check` | `20261023_demo_chat_journeys` |
| Function `demo_chat_reject_mutation()`; trigger `demo_chat_audit_log_append_only` (UPDATE/DELETE rejected) | `20261023_demo_chat_journeys` |
| Statement trigger `demo_chat_audit_log_no_truncate` (TRUNCATE rejected) | `20261024_demo_chat_audit_truncate_guard` |

`scripts/migrationBaseline.test.mjs` fails if any of them disappears from the baseline.

**Expected Prisma drift:** `prisma migrate diff` (database → schema) reports exactly one line —
`CREATE UNIQUE INDEX "collections_slug_key" ON "collections"("slug")` — because Prisma does not
recognise the partial index as its `@unique`. In PostgreSQL both forms behave the same (NULLs never
conflict in a unique index). The other custom indexes are not reported.

## Guarded baseline

Section 0 of the baseline is a guard that runs **before any DDL**: if the target schema already contains
any table (other than `_prisma_migrations`) or any of the schema's enum types, it raises
`BASELINE REFUSED … Nothing was changed.` (`P0001`). The script runs as one implicit transaction, so
nothing below the guard executes. Rehearsed: against a database with all tables and data plus the 28
archived names in `_prisma_migrations`, `migrate deploy` stopped with `P3018`, a full `pg_dump` of the
application tables was byte-identical before and after, and Prisma recorded the baseline as failed
(recoverable with the resolve command below). Without `_prisma_migrations`, Prisma itself refuses a
non-empty database first (`P3005`).

## Existing database (e.g. Production) — NOT done by this repository

An existing database already contains everything the baseline creates and must **not** run it. It is
baselined once, by an operator, before its next `prisma migrate deploy`:

1. **Independently approved, READ-ONLY comparison first** (no writes):
   - `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at;`
   - `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`
     — anything beyond the expected `collections_slug_key` line is drift to resolve first.
   - Confirm the custom objects above exist (`pg_constraint`, `pg_trigger`, `pg_proc`, `pg_indexes`).
2. Backup.
3. `npx prisma migrate resolve --applied 20261025000000_baseline` (records the baseline as applied; changes
   no table). The 28 historical rows stay in `_prisma_migrations`; Prisma 6.19.3 `migrate status` /
   `migrate deploy` were rehearsed to accept them silently.
4. `npx prisma migrate status` → "Database schema is up to date!".

If step 3 is forgotten, `migrate deploy` stops at the guard (P3018, nothing changed); run step 3, which
also accepts a failed baseline. **No database — Production included — has been baselined by this change.**

## Rules for future migrations

- Generate with `npx prisma migrate dev --create-only` (or `migrate diff`) and **review the SQL**: Prisma may
  emit `DROP INDEX` for the partial / expression indexes above, or a plain `collections_slug_key`. Delete
  such statements — those indexes are intentional.
- Custom objects (CHECK, trigger, function, partial/expression index) go in raw SQL in the migration and in
  the table above; extend `scripts/migrationBaseline.test.mjs` when they protect data.
- Never edit, rename or delete an applied migration (including the baseline) or anything in
  `prisma/migrations_archive/`.
