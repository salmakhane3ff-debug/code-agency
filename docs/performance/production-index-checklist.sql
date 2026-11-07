-- =============================================================================================
-- docs/performance/production-index-checklist.sql
-- Affiliate Recruiter System — READ-ONLY index checklist for the PRODUCTION database
-- (Phase 6 Part 5a, corrected in Part 5e). Running this file changes nothing.
-- =============================================================================================
--
-- WHO / WHY
--   For a person authorized to connect to the production database. Part 5b–5d made the recruiter
--   network, ancestry and reward-reconciliation queries depend on a few indexes. Two of them are
--   declared in prisma/schema.prisma but created by NO committed migration — affiliates("parentId")
--   and affiliate_orders("affiliateId") — so production may or may not have them. This file shows,
--   for each index the Part 5 audit relies on, whether it EXISTS, is VALID and READY, has been
--   USED according to the statistics, or NEEDS INVESTIGATION. It does not create anything.
--
-- WHAT IT READS (sections 1–4: system catalogs and statistics views only — never a table row;
-- section 5, Phase 7 Stage F: two id columns of two tables, see below)
--   0. One READ ONLY transaction; its time limits are SET LOCAL (they end with the transaction).
--   1. Server version and what this role may read.
--   2. The justified indexes: existence, validity, readiness, size, usage counters, classification.
--   3. Table-level scan counters and maintenance dates of the tables of those indexes.
--   4. pg_stat_statements AGGREGATES (counts and times only — never the query text), if available.
--   5. (Phase 7 Stage F — recruiter ownership, the TOPMOST link wins) the CONFLICTING recruiter links:
--      a link to recruiter B on an affiliate whose chain has a linked ancestor of another recruiter above
--      it (NESTED), or a link on a parent cycle meeting several recruiters (AMBIGUOUS_CYCLE). Reads ONLY
--      affiliates."id" / "parentId" and recruiter_affiliate_links."affiliateId" / "recruiterId"; outputs
--      the counts and at most 200 affiliate ids (no name, username, phone or any other column). Skipped
--      when recruiter_affiliate_links or affiliates."parentId" does not exist. Nothing is reassigned or
--      modified — report only.
--   6. Database capabilities the migrations need: version, encoding / collation, TEMP and CREATE
--      privileges, gen_random_uuid / pgcrypto, plpgsql, superuser flag, table ownership (booleans only —
--      no role name is printed).
--   7. _prisma_migrations: totals, failed / rolled-back rows, and every migration of this repository
--      (38) as APPLIED / FAILED / NOT_RECORDED, plus rows the repository does not know. Never the
--      "logs" text. Skipped (with a message) when the table is absent or not readable by this role.
--   8. Required tables and columns (affiliates."parentId", affiliate_orders, affiliate_payouts, the
--      recruiter tables, the 20261112 settings columns): exists, type, nullability, default.
--   9. Required triggers (present / enabled / unexpected), CHECK constraints (present / validated) and
--      foreign keys (matched by columns, with their ON DELETE action).
--   Sections 6–9 run BEFORE section 5 (file order 1, 2, 3, 4, 6, 7, 8, 9, 5): section 5 is the only one
--   that walks data, so a timeout there can never hide the catalog checks. Section numbers are kept
--   stable because src/lib/services/recruiterRewardService.js refers to "section 5".
--   ROLLBACK at the end.
--
-- SAFETY
--   * BEGIN TRANSACTION READ ONLY is the FIRST statement; statement_timeout, lock_timeout and
--     idle_in_transaction_session_timeout are SET LOCAL inside it, so they cannot outlive the
--     transaction — not on this connection, not on a pooled connection reused later, and not
--     through a transaction-pooling proxy (a transaction never changes server connection there).
--   * The server refuses any write in a READ ONLY transaction; there is no DDL, no ANALYZE / VACUUM,
--     no EXPLAIN, no function call with side effects, no temporary table, no SET without LOCAL,
--     no ALTER ... SET. The file ends with ROLLBACK.
--   * With ON_ERROR_STOP, any error stops psql; the server then aborts the open transaction
--     (nothing was written anyway) and the SET LOCAL values are discarded with it.
--   * Output contains only catalog metadata (table / index names, index definitions, sizes,
--     validity flags) and counters — and, in section 5 only, conflict counts and affiliate ids. No
--     other table data, no pg_stats sample value, no pg_stat_statements query text, no customer
--     name / phone / address / order detail or other personal data.
--
-- HOW TO RUN (psql 10 or later; PostgreSQL server 11 to 17; any role that can read the catalog —
-- usage counters of other roles' activity may need pg_read_all_stats, see section 1)
--   psql "<connection string>" -X -v ON_ERROR_STOP=1 \
--        -f docs/performance/production-index-checklist.sql > recruiter-index-checklist.txt 2>&1
--   Send recruiter-index-checklist.txt back. Duration: well under a second on a normal catalog for
--   sections 1–4; section 5 walks the affiliates below a recruiter link once (index lookups) — on
--   the 10k disposable dataset it took well under a second; statement_timeout (15s) bounds it.
--   A direct connection is preferred; through a transaction pooler (e.g. PgBouncer in transaction
--   mode) it is also safe, because every statement runs inside the one explicit transaction.
--
-- VERSION NOTES
--   * PostgreSQL 11+: pg_index.indnkeyatts (key columns without INCLUDE columns) is used.
--   * pg_stat_statements: total_exec_time on 13+, total_time on 11–12 (both handled).
--   * pg_stat_user_indexes.last_idx_scan exists only on 16+; it is shown there and reported as
--     "(n/a before 16)" otherwise.
--   * shared_preload_libraries is readable only by superusers / pg_read_all_settings members; when it
--     cannot be read, section 4 is skipped instead of failing.
--   * Usage counters (idx_scan) count since the last statistics reset (shown) and are per server:
--     on a replica they only reflect the replica's own queries.
-- =============================================================================================

\set ON_ERROR_STOP on
\pset pager off
\pset null '(null)'

-- ── 0. Read-only transaction FIRST, then transaction-local time limits ───────────────────────
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '5min';
SELECT current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('statement_timeout') AS statement_timeout,
       current_setting('lock_timeout') AS lock_timeout;

-- ── 1. Server version and what this role may read ────────────────────────────────────────────
\echo '== 1. Server version and privileges =='
-- Version gate FIRST: on very old servers the predefined roles below do not exist.
SELECT current_setting('server_version_num')::int >= 110000 AS version_ok,
       current_setting('server_version_num')::int >= 160000 AS has_last_idx_scan
\gset
\if :version_ok
\else
\echo 'PostgreSQL older than 11: this checklist is not supported (pg_index.indnkeyatts missing). Stopping.'
ROLLBACK;
\quit
\endif
SELECT current_setting('server_version') AS server_version,
       current_setting('server_version_num')::int AS server_version_num,
       current_database() AS database,
       now() AS checked_at,
       pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS can_read_all_stats,
       pg_has_role(current_user, 'pg_read_all_settings', 'MEMBER') AS can_read_all_settings;
SELECT stats_reset AS statistics_reset_at FROM pg_stat_database WHERE datname = current_database();

-- ── 2. The justified indexes: exists / valid & ready / used / needs investigation ───────────
-- Each expected shape is matched by its key columns (in order, INCLUDE columns ignored) and, for
-- the ledger cycle guards, by their partial predicate. "why" says which Part 5 query relies on it.
\echo '== 2. Index checklist (EXISTS / VALID_READY / USED / INVESTIGATE) =='
WITH expected(check_no, tbl, cols, pred, why) AS (VALUES
  (1,  'affiliates',                ARRAY['parentId'],                 NULL,
       'network walks (5b) and reward-candidate ancestry: per-node child lookup. schema.prisma only - no committed migration creates it'),
  (2,  'affiliate_orders',          ARRAY['affiliateId'],              NULL,
       'network order counts (5b) and reconcile candidate delivered counts (5d). schema.prisma only - no committed migration creates it'),
  (3,  'affiliates',                ARRAY['id'],                       NULL,
       'primary key: ancestry walk (5c) and network path walk (5b)'),
  (4,  'recruiter_affiliate_links', ARRAY['affiliateId'],              NULL,
       'primary key: membership check in every walk; reconcile keyset batches (5d)'),
  (5,  'recruiter_affiliate_links', ARRAY['recruiterId', 'createdAt'], NULL,
       'network member count, unplaced paging, recruiter-scoped reconcile (migration 20261105)'),
  (6,  'identity_verifications',    ARRAY['affiliateId'],              NULL,
       'identity status join of network statistics and award candidates (migration 20260725, unique)'),
  (7,  'recruiter_reward_ledger',   ARRAY['affiliateId', 'cycle'],     'RECRUIT_REWARD',
       'reconcile candidate cycle state (5d): partial unique one_recruit_per_cycle (migration 20261110)'),
  (8,  'recruiter_reward_ledger',   ARRAY['affiliateId', 'cycle'],     'REVERSAL',
       'reconcile candidate cycle state (5d): partial unique one_reversal_per_cycle (migration 20261110)'),
  (9,  'recruiter_reward_ledger',   ARRAY['affiliateId'],              NULL,
       'reward sync cycle state per affiliate (migration 20261105)'),
  (10, 'recruiter_reward_ledger',   ARRAY['recruiterId', 'createdAt'], NULL,
       'wallet earned total and history (migration 20261105)'),
  (11, 'recruiter_reward_ledger',   ARRAY['recruiterId', 'cycle'],     'GROUP_REWARD',
       'group reward cycles (Phase 7): partial unique per recruiter and cycle (migration 20261112 - MISSING before it)'),
  (12, 'recruiter_reward_ledger',   ARRAY['recruiterId', 'cycle'],     'GROUP_REVERSAL',
       'group reversal cycles (Phase 7): partial unique per recruiter and cycle (migration 20261112 - MISSING before it)')
),
idx AS (
  SELECT t.relname::text AS tbl,
         ic.relname::text AS index_name,
         x.indisvalid AS valid,
         x.indisready AS ready,
         x.indisunique AS is_unique,
         x.indisprimary AS is_primary,
         CASE WHEN x.indpred IS NULL THEN NULL ELSE pg_get_expr(x.indpred, x.indrelid) END AS predicate,
         pg_relation_size(ic.oid) AS bytes,
         ARRAY(SELECT coalesce(a.attname::text, '(expression)')
               FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
               LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
               WHERE k.ord <= x.indnkeyatts
               ORDER BY k.ord) AS keycols,
         s.idx_scan
  FROM pg_index x
  JOIN pg_class ic ON ic.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid
  WHERE t.relnamespace = 'public'::regnamespace
),
matched AS (
  SELECT e.check_no, e.tbl, e.cols, e.pred, e.why,
         i.index_name, i.valid, i.ready, i.is_unique, i.is_primary, i.predicate, i.bytes, i.keycols, i.idx_scan
  FROM expected e
  LEFT JOIN idx i
    ON i.tbl = e.tbl
   AND i.keycols[1:cardinality(e.cols)] = e.cols
   AND (e.pred IS NULL AND i.predicate IS NULL
        OR e.pred IS NOT NULL AND i.predicate IS NOT NULL AND i.predicate LIKE '%' || quote_literal(e.pred) || '%')
)
SELECT check_no,
       tbl || ' (' || array_to_string(ARRAY(SELECT quote_ident(c) FROM unnest(cols) AS c), ', ') || ')'
         || CASE WHEN pred IS NOT NULL THEN ' WHERE type = ' || quote_literal(pred) ELSE '' END AS expected_shape,
       CASE WHEN to_regclass('public.' || quote_ident(tbl)) IS NULL THEN 'TABLE MISSING'
            WHEN count(index_name) = 0 THEN 'MISSING'
            ELSE 'EXISTS' END AS exists_status,
       CASE WHEN count(index_name) = 0 THEN '-'
            WHEN bool_or(valid AND ready) THEN 'VALID_READY'
            ELSE 'NOT VALID / NOT READY' END AS validity,
       CASE WHEN count(index_name) = 0 THEN '-'
            WHEN bool_or(valid AND ready AND coalesce(idx_scan, 0) > 0) THEN 'USED'
            WHEN bool_or(valid AND ready AND idx_scan IS NULL) THEN 'NO STATISTICS'
            ELSE 'NOT USED SINCE RESET' END AS usage,
       CASE WHEN to_regclass('public.' || quote_ident(tbl)) IS NULL OR count(index_name) = 0
              OR NOT bool_or(valid AND ready) THEN 'INVESTIGATE'
            WHEN NOT bool_or(valid AND ready AND coalesce(idx_scan, 0) > 0) THEN 'INVESTIGATE (unused or no statistics)'
            ELSE 'OK' END AS verdict,
       string_agg(index_name || ' [' || array_to_string(keycols, ', ') || ']'
                  || CASE WHEN keycols = cols THEN ' exact' ELSE ' leading' END
                  || CASE WHEN is_primary THEN ' PK' WHEN is_unique THEN ' UNIQUE' ELSE '' END
                  || CASE WHEN NOT valid THEN ' INVALID' ELSE '' END
                  || CASE WHEN NOT ready THEN ' NOT_READY' ELSE '' END
                  || ' scans=' || coalesce(idx_scan::text, 'n/a')
                  || ' ' || pg_size_pretty(bytes), '; ' ORDER BY index_name) AS matching_indexes,
       why
FROM matched
GROUP BY check_no, tbl, cols, pred, why
ORDER BY check_no;

-- Full definitions of the matching indexes (catalog text only: names, columns, predicates).
\echo '-- definitions of the indexes on these tables'
SELECT t.relname AS "table", ic.relname AS "index", pg_get_indexdef(x.indexrelid) AS definition,
       x.indisvalid AS valid, x.indisready AS ready, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch
FROM pg_index x
JOIN pg_class ic ON ic.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid
WHERE t.relnamespace = 'public'::regnamespace
  AND t.relname IN ('affiliates', 'affiliate_orders', 'affiliate_payouts', 'recruiter_affiliate_links', 'identity_verifications', 'recruiter_reward_ledger')
ORDER BY 1, 2;

\if :has_last_idx_scan
SELECT s.relname AS "table", s.indexrelname AS "index", s.last_idx_scan
FROM pg_stat_user_indexes s
WHERE s.schemaname = 'public'
  AND s.relname IN ('affiliates', 'affiliate_orders', 'recruiter_affiliate_links', 'identity_verifications', 'recruiter_reward_ledger')
ORDER BY 1, 2;
\else
\echo 'last_idx_scan: (n/a before 16)'
\endif

-- ── 3. Table-level counters of the same tables (no row is read) ──────────────────────────────
-- A high seq_scan / seq_tup_read next to a MISSING or unused index is the main "investigate" signal.
\echo '== 3. Table scan counters and maintenance dates =='
SELECT c.relname AS "table",
       c.reltuples::bigint AS row_estimate,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
       s.seq_scan, s.seq_tup_read, s.idx_scan, s.n_live_tup, s.n_dead_tup,
       s.last_analyze, s.last_autoanalyze, s.last_vacuum, s.last_autovacuum
FROM pg_class c
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  AND c.relname IN ('affiliates', 'affiliate_orders', 'recruiter_affiliate_links', 'identity_verifications', 'recruiter_reward_ledger')
ORDER BY c.relname;

-- ── 4. pg_stat_statements: AGGREGATES only (never the query text) ────────────────────────────
-- Used only when the extension is installed in this database AND shared_preload_libraries can be
-- read and lists it. The query text is used server-side only to group statements by the tables
-- they mention; only counts and times leave the server.
\echo '== 4. pg_stat_statements aggregates (if available) =='
-- The column set is read from the installed VIEW, not from the server version: after pg_upgrade the
-- extension can stay at an old version (total_time) until ALTER EXTENSION ... UPDATE.
WITH ext AS (
  SELECT n.nspname, to_regclass(quote_ident(n.nspname) || '.pg_stat_statements') AS view
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pg_stat_statements'
)
SELECT coalesce((SELECT nspname FROM ext), '') AS pgss_schema,
       coalesce((SELECT has_schema_privilege(ext.nspname, 'USAGE') AND has_table_privilege(ext.view, 'SELECT') FROM ext), false)
         AND coalesce((SELECT setting FROM pg_settings WHERE name = 'shared_preload_libraries'), '') ILIKE '%pg_stat_statements%'
         AS pgss_ok,
       EXISTS (SELECT 1 FROM ext JOIN pg_attribute a ON a.attrelid = ext.view
               WHERE a.attname = 'total_exec_time' AND a.attnum > 0 AND NOT a.attisdropped) AS pgss_exec_time_cols
\gset
\if :pgss_ok
\if :pgss_exec_time_cols
SELECT g.tbl AS mentions_table,
       count(*) AS normalized_statements,
       sum(p.calls) AS calls,
       round(sum(p.total_exec_time)::numeric, 1) AS total_ms,
       round((sum(p.total_exec_time) / nullif(sum(p.calls), 0))::numeric, 3) AS mean_ms_per_call,
       sum(p.shared_blks_read) AS shared_blks_read
FROM :"pgss_schema".pg_stat_statements p
CROSS JOIN LATERAL (VALUES ('affiliates'), ('affiliate_orders'), ('recruiter_affiliate_links'),
                           ('identity_verifications'), ('recruiter_reward_ledger')) AS g(tbl)
WHERE p.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND p.query ~ ('(^|[^a-z_])"?' || g.tbl || '"?([^a-z_]|$)')
GROUP BY g.tbl
ORDER BY g.tbl;
\else
SELECT g.tbl AS mentions_table,
       count(*) AS normalized_statements,
       sum(p.calls) AS calls,
       round(sum(p.total_time)::numeric, 1) AS total_ms,
       round((sum(p.total_time) / nullif(sum(p.calls), 0))::numeric, 3) AS mean_ms_per_call,
       sum(p.shared_blks_read) AS shared_blks_read
FROM :"pgss_schema".pg_stat_statements p
CROSS JOIN LATERAL (VALUES ('affiliates'), ('affiliate_orders'), ('recruiter_affiliate_links'),
                           ('identity_verifications'), ('recruiter_reward_ledger')) AS g(tbl)
WHERE p.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND p.query ~ ('(^|[^a-z_])"?' || g.tbl || '"?([^a-z_]|$)')
GROUP BY g.tbl
ORDER BY g.tbl;
\endif
\else
\echo 'pg_stat_statements not installed here, not preloaded, not readable by this role, or shared_preload_libraries not readable by this role: section skipped.'
\endif

-- ── 6. Database capabilities required by the migrations (booleans; no role name printed) ─────
-- gen_random_uuid() is built in from PostgreSQL 13 (pgcrypto before); 20261030 refuses a non-UTF8
-- database and uses a pg_temp helper (TEMP privilege); the migrations create plpgsql functions and
-- triggers, which need the migration role to OWN the tables. Pooler mode cannot be seen from SQL:
-- prisma migrate needs a DIRECT connection (session-level advisory lock), never a transaction pooler.
-- The role_* columns describe the role RUNNING this file; to check the migration role, run the file once
-- more connected as that role (it stays read-only).
\echo '== 6. Database capabilities =='
SELECT current_setting('server_version_num')::int >= 130000 AS pg13_or_later,
       pg_encoding_to_char(d.encoding) AS encoding,
       pg_encoding_to_char(d.encoding) = 'UTF8' AS encoding_is_utf8,
       d.datcollate AS lc_collate,
       d.datctype AS lc_ctype,
       has_database_privilege(current_database(), 'TEMP') AS role_can_create_temp,
       has_database_privilege(current_database(), 'CREATE') AS role_can_create_schema,
       has_schema_privilege('public', 'CREATE') AS role_can_create_in_public,
       to_regprocedure('gen_random_uuid()') IS NOT NULL AS gen_random_uuid_available,
       EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') AS pgcrypto_installed,
       EXISTS (SELECT 1 FROM pg_language WHERE lanname = 'plpgsql') AS plpgsql_available,
       coalesce((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false) AS role_is_superuser,
       current_setting('jit') AS jit
FROM pg_database d
WHERE d.datname = current_database();
\echo '-- ownership of the tables the migrations alter (the migration role must own them)'
WITH t(tbl) AS (VALUES ('affiliates'), ('affiliate_orders'), ('affiliate_payouts'), ('identity_verifications'),
                       ('recruiters'), ('recruiter_affiliate_links'), ('recruiter_reward_ledger'),
                       ('recruiter_audit_log'), ('recruiter_settings_versions'))
SELECT t.tbl AS "table",
       c.oid IS NOT NULL AS table_exists,
       c.relowner = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) AS owned_by_this_role,
       c.relowner = (SELECT a.relowner FROM pg_class a WHERE a.oid = to_regclass('public.affiliates')) AS same_owner_as_affiliates
FROM t
LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || quote_ident(t.tbl))
ORDER BY t.tbl;

-- ── 7. _prisma_migrations: applied / failed / not recorded (never the "logs" text) ───────────
-- A row with finished_at NULL and rolled_back_at NULL is a FAILED (or in-progress) migration: prisma
-- migrate deploy refuses to run until it is resolved. NOT_RECORDED means the repository migration has no
-- row (its objects may still exist if the database was built with db push / manual SQL — verify with
-- sections 8–9 before any `prisma migrate resolve --applied`). The repository list below is the 38
-- migrations of this release, in prisma's (lexical) order.
\echo '== 7. Prisma migration history =='
SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_prisma_migrations,
       coalesce(has_table_privilege(to_regclass('public._prisma_migrations'), 'SELECT'), false) AS can_read_prisma_migrations
\gset
\if :can_read_prisma_migrations
SELECT count(*) AS rows_total,
       count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS failed_or_in_progress,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back,
       count(DISTINCT migration_name) AS distinct_names
FROM public._prisma_migrations;
WITH repo(ord, migration_name) AS (VALUES
  (1, '20260316214921_phase1_add_promo_spin_shipping_reviews_invoice_campaigns'),
  (2, '20260316_add_content_items'), (3, '20260316_add_posts_images'), (4, '20260316_init'),
  (5, '20260422_add_gift_countdown'), (6, '20260423_abandoned_cart_orderid'), (7, '20260423_add_abandoned_carts'),
  (8, '20260627_add_bemob_tracking'), (9, '20260630_affiliate_goals'), (10, '20260716_product_feed_index'),
  (11, '20260717_duplicate_detector'), (12, '20260720_ugc_module'), (13, '20260721_ugc_audit_notifications'),
  (14, '20260722_ugc_daily_targets'), (15, '20260723_demo_avatars_ugc'), (16, '20260724_fake_orders_engine'),
  (17, '20260725_identity_verification'), (18, '20260726_product_purchase_flow'),
  (19, '20260727_affiliate_security_deposit'), (20, '20260727_demo_auto_simulation'),
  (21, '20260731_booster_purchases'), (22, '20260801_booster_payment_split'), (23, '20260802_booster_simulation'),
  (24, '20260806_feedback_review_date'), (25, '20261019_affiliate_rewards'), (26, '20261020_product_lock'),
  (27, '20261028_brand_simulator'), (28, '20261029_brand_lifecycle_history'), (29, '20261030_brand_terms_consent'),
  (30, '20261104_payment_proofs'), (31, '20261105_affiliate_recruiter_system'),
  (32, '20261106_recruiter_rewards_withdrawals'), (33, '20261107_affiliate_activation_codes'),
  (34, '20261108_affiliate_activation_recovery'), (35, '20261109_account_token_version'),
  (36, '20261110_recruiter_reward_cycles'), (37, '20261111_recruiter_identity_verifications'),
  (38, '20261112_recruiter_group_rewards')
),
db AS (
  SELECT migration_name,
         bool_or(finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
         bool_or(finished_at IS NULL AND rolled_back_at IS NULL) AS failed,
         count(*) AS row_count,
         max(finished_at) AS finished_at
  FROM public._prisma_migrations
  GROUP BY migration_name
)
SELECT r.ord,
       coalesce(r.migration_name, d.migration_name) AS migration_name,
       CASE WHEN r.migration_name IS NULL THEN 'IN_DATABASE_NOT_IN_REPOSITORY'
            WHEN d.migration_name IS NULL THEN 'NOT_RECORDED'
            WHEN d.failed THEN 'FAILED'
            WHEN d.applied THEN 'APPLIED'
            ELSE 'ROLLED_BACK_ONLY' END AS status,
       d.row_count AS rows,
       d.finished_at
FROM repo r
FULL JOIN db d ON d.migration_name = r.migration_name
ORDER BY r.ord NULLS LAST, 2;
\echo '-- failed / rolled-back rows (metadata only; the logs text is never printed)'
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count, logs IS NOT NULL AS has_logs
FROM public._prisma_migrations
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
ORDER BY started_at;
\else
\if :has_prisma_migrations
\echo '_prisma_migrations exists but this role cannot SELECT it: section 7 skipped (grant SELECT on it to the read-only role and re-run).'
\else
\echo '_prisma_migrations does NOT exist: this database was not built by prisma migrate (db push / manual SQL) - it must be baselined before any migrate deploy.'
\endif
\endif

-- ── 8. Required tables and columns (catalog only) ─────────────────────────────────────────────
-- expect_nullable: true / false when the release needs it, NULL when either is acceptable.
-- "needed_by" says why; rows marked 20261112 are EXPECTED to be missing before that migration.
\echo '== 8. Required tables and columns =='
WITH expected(tbl, col, expect_nullable, needed_by) AS (VALUES
  ('affiliates',                  'id',                     false, 'every recruiter feature'),
  ('affiliates',                  'parentId',               true,  'network, ownership, ancestry, 20261112 triggers - created by NO committed migration'),
  ('affiliates',                  'userId',                 true,  'recruiter-created affiliates have no user (must be nullable)'),
  ('affiliates',                  'isActive',               false, '20261105 link trigger'),
  ('affiliates',                  'createdAt',              false, '20261105 link trigger, ordering'),
  ('affiliates',                  'tokenVersion',           false, '20261109'),
  ('affiliate_orders',            'id',                     false, '20261019 FK target - table created by NO committed migration'),
  ('affiliate_orders',            'affiliateId',            NULL,  'reward / network order counts'),
  ('affiliate_orders',            'status',                 false, 'qualifying sale = delivered'),
  ('affiliate_orders',            'isFake',                 false, 'qualifying sale = real (20260724)'),
  ('affiliate_orders',            'orderId',                NULL,  'linked-order hook'),
  ('affiliate_payouts',           'id',                     false, '20261106 - table created by NO committed migration'),
  ('affiliate_payouts',           'affiliateId',            true,  'nullable after 20261106 (recruiter payouts)'),
  ('affiliate_payouts',           'recruiterId',            true,  '20261106'),
  ('affiliate_payouts',           'amount',                 false, '20261106 amount CHECK'),
  ('affiliate_payouts',           'status',                 false, 'payout lifecycle'),
  ('identity_verifications',      'affiliateId',            false, 'KYC gate (20260725)'),
  ('identity_verifications',      'status',                 false, 'KYC gate (20260725)'),
  ('recruiters',                  'id',                     false, '20261105'),
  ('recruiters',                  'tokenVersion',           false, '20261109'),
  ('recruiter_affiliate_links',   'affiliateId',            false, '20261105'),
  ('recruiter_affiliate_links',   'recruiterId',            false, '20261105'),
  ('recruiter_reward_ledger',     'cycle',                  false, '20261110'),
  ('recruiter_reward_ledger',     'settingsVersion',        true,  '20261105'),
  ('recruiter_settings_versions', 'minDeliveredSales',      false, '20261105'),
  ('recruiter_settings_versions', 'groupEnabled',           false, '20261112'),
  ('recruiter_settings_versions', 'groupRewardAmountCents', false, '20261112'),
  ('recruiter_settings_versions', 'groupSize',              false, '20261112'),
  ('recruiter_settings_versions', 'groupMinDeliveredSales', false, '20261112'),
  ('recruiter_identity_verifications', 'status',            false, '20261111')
)
SELECT e.tbl AS "table",
       e.col AS "column",
       to_regclass('public.' || quote_ident(e.tbl)) IS NOT NULL AS table_exists,
       a.attname IS NOT NULL AS column_exists,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       CASE WHEN a.attname IS NULL THEN NULL ELSE NOT a.attnotnull END AS nullable,
       a.atthasdef AS has_default,
       CASE WHEN to_regclass('public.' || quote_ident(e.tbl)) IS NULL THEN 'TABLE MISSING'
            WHEN a.attname IS NULL THEN 'COLUMN MISSING'
            WHEN e.expect_nullable IS NOT NULL AND (NOT a.attnotnull) <> e.expect_nullable
              THEN CASE WHEN e.expect_nullable THEN 'NOT NULL (expected nullable)' ELSE 'NULLABLE (expected NOT NULL)' END
            ELSE 'OK' END AS status,
       e.needed_by
FROM expected e
LEFT JOIN pg_attribute a
  ON a.attrelid = to_regclass('public.' || quote_ident(e.tbl))
 AND a.attname = e.col AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY e.tbl, e.col;

-- ── 9. Required triggers, CHECK constraints and foreign keys (catalog only) ─────────────────
-- expect_present false = the migration DROPPED it (it must not exist any more). Rows of a migration
-- that is not applied yet (e.g. 20261112 before the release) are expected to be MISSING.
\echo '== 9a. Triggers =='
WITH expected(migration, tbl, trg, expect_present) AS (VALUES
  ('20261105', 'recruiter_affiliate_links',        'recruiter_affiliate_links_immutable',          true),
  ('20261105', 'recruiter_affiliate_links',        'recruiter_affiliate_links_new_only',           true),
  ('20261105', 'recruiter_affiliate_links',        'recruiter_affiliate_links_no_truncate',        true),
  ('20261105', 'recruiter_audit_log',              'recruiter_audit_log_append_only',              true),
  ('20261105', 'recruiter_audit_log',              'recruiter_audit_log_no_truncate',              true),
  ('20261105', 'recruiter_reward_ledger',          'recruiter_reward_ledger_append_only',          true),
  ('20261105', 'recruiter_reward_ledger',          'recruiter_reward_ledger_link_guard',           true),
  ('20261105', 'recruiter_reward_ledger',          'recruiter_reward_ledger_no_truncate',          true),
  ('20261105', 'recruiter_reward_ledger',          'recruiter_reward_ledger_reversal_guard',       false),
  ('20261105', 'recruiter_settings_versions',      'recruiter_settings_versions_append_only',      true),
  ('20261105', 'recruiter_settings_versions',      'recruiter_settings_versions_consecutive',      true),
  ('20261105', 'recruiter_settings_versions',      'recruiter_settings_versions_no_truncate',      true),
  ('20261107', 'affiliate_activation_codes',       'affiliate_activation_codes_guard',             true),
  ('20261107', 'affiliate_activation_codes',       'affiliate_activation_codes_no_truncate',       true),
  ('20261108', 'affiliate_activation_recoveries',  'affiliate_activation_recoveries_guard',        true),
  ('20261108', 'affiliate_activation_recoveries',  'affiliate_activation_recoveries_no_truncate',  true),
  ('20261110', 'recruiter_reward_ledger',          'recruiter_reward_ledger_cycle_guard',          true),
  ('20261111', 'recruiter_identity_verifications', 'recruiter_identity_verifications_guard',       true),
  ('20261111', 'recruiter_identity_verifications', 'recruiter_identity_verifications_no_truncate', true),
  ('20261112', 'recruiter_reward_ledger',          'recruiter_reward_ledger_group_cycle_guard',    true),
  ('20261112', 'recruiter_affiliate_links',        'recruiter_affiliate_links_owner_guard',        true),
  ('20261112', 'affiliates',                       'affiliates_children_delete_guard',             true)
)
SELECT e.migration, e.tbl AS "table", e.trg AS "trigger",
       t.oid IS NOT NULL AS present,
       CASE t.tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA_ONLY'
                        WHEN 'D' THEN 'DISABLED' END AS enabled,
       p.proname AS "function",
       CASE WHEN to_regclass('public.' || quote_ident(e.tbl)) IS NULL THEN 'TABLE MISSING'
            WHEN e.expect_present AND t.oid IS NULL THEN 'MISSING'
            WHEN NOT e.expect_present AND t.oid IS NOT NULL THEN 'UNEXPECTED (dropped by 20261110)'
            WHEN NOT e.expect_present THEN 'OK (absent as expected)'
            WHEN t.tgenabled = 'D' THEN 'DISABLED'
            ELSE 'OK' END AS status
FROM expected e
LEFT JOIN pg_trigger t
  ON t.tgrelid = to_regclass('public.' || quote_ident(e.tbl)) AND t.tgname = e.trg AND NOT t.tgisinternal
LEFT JOIN pg_proc p ON p.oid = t.tgfoid
ORDER BY e.migration, e.tbl, e.trg;
\echo '-- every user trigger on these tables (names only; anything not listed above deserves a look)'
SELECT c.relname AS "table", t.tgname AS "trigger",
       CASE t.tgenabled WHEN 'O' THEN 'ENABLED' WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA_ONLY'
                        WHEN 'D' THEN 'DISABLED' END AS enabled
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('affiliates', 'affiliate_orders', 'affiliate_payouts', 'recruiters', 'recruiter_affiliate_links',
                    'recruiter_reward_ledger', 'recruiter_audit_log', 'recruiter_settings_versions',
                    'recruiter_identity_verifications', 'affiliate_activation_codes', 'affiliate_activation_recoveries')
ORDER BY 1, 2;

\echo '== 9b. CHECK constraints =='
WITH expected(migration, tbl, con) AS (VALUES
  ('20261105', 'recruiters',                       'recruiters_username_check'),
  ('20261105', 'recruiters',                       'recruiters_name_check'),
  ('20261105', 'recruiters',                       'recruiters_password_hash_check'),
  ('20261105', 'recruiters',                       'recruiters_disabled_check'),
  ('20261105', 'recruiter_affiliate_links',        'recruiter_affiliate_links_createdBy_check'),
  ('20261105', 'recruiter_reward_ledger',          'recruiter_reward_ledger_type_check'),
  ('20261105', 'recruiter_reward_ledger',          'recruiter_reward_ledger_actor_check'),
  ('20261105', 'recruiter_reward_ledger',          'recruiter_reward_ledger_amount_check'),
  ('20261105', 'recruiter_audit_log',              'recruiter_audit_log_actor_check'),
  ('20261105', 'recruiter_audit_log',              'recruiter_audit_log_action_check'),
  ('20261105', 'recruiter_settings_versions',      'recruiter_settings_versions_check'),
  ('20261106', 'affiliate_payouts',                'affiliate_payouts_owner_check'),
  ('20261106', 'affiliate_payouts',                'affiliate_payouts_recruiter_amount_check'),
  ('20261108', 'affiliate_activation_codes',       'affiliate_activation_codes_check'),
  ('20261108', 'affiliate_activation_recoveries',  'affiliate_activation_recoveries_check'),
  ('20261109', 'affiliates',                       'affiliates_tokenVersion_check'),
  ('20261109', 'recruiters',                       'recruiters_tokenVersion_check'),
  ('20261110', 'recruiter_reward_ledger',          'recruiter_reward_ledger_cycle_check'),
  ('20261111', 'recruiter_identity_verifications', 'recruiter_identity_verifications_state_check'),
  ('20261112', 'recruiter_reward_ledger',          'recruiter_reward_ledger_group_check'),
  ('20261112', 'recruiter_settings_versions',      'recruiter_settings_versions_group_check')
)
SELECT e.migration, e.tbl AS "table", e.con AS "constraint",
       c.oid IS NOT NULL AS present,
       c.convalidated AS validated,
       CASE WHEN to_regclass('public.' || quote_ident(e.tbl)) IS NULL THEN 'TABLE MISSING'
            WHEN c.oid IS NULL THEN 'MISSING'
            WHEN c.contype <> 'c' THEN 'NOT A CHECK'
            WHEN NOT c.convalidated THEN 'NOT VALIDATED'
            ELSE 'OK' END AS status
FROM expected e
LEFT JOIN pg_constraint c
  ON c.conrelid = to_regclass('public.' || quote_ident(e.tbl)) AND c.conname = e.con
ORDER BY e.migration, e.tbl, e.con;
\echo '-- 20261112 widens the ledger type CHECK: GROUP_REWARD / GROUP_REVERSAL allowed?'
SELECT coalesce(bool_or(pg_get_constraintdef(c.oid) LIKE '%GROUP_REWARD%'), false) AS ledger_type_check_allows_group_types
FROM pg_constraint c
WHERE c.conrelid = to_regclass('public.recruiter_reward_ledger') AND c.conname = 'recruiter_reward_ledger_type_check';

\echo '== 9c. Foreign keys (matched by columns; names may differ outside the migrations) =='
WITH expected(tbl, col, ref_tbl, expected_on_delete, origin) AS (VALUES
  ('affiliates',                       'parentId',         'affiliates',                 'SET NULL', 'schema.prisma only (no committed migration)'),
  ('affiliate_orders',                 'affiliateId',      'affiliates',                 NULL,       'schema.prisma only (no committed migration)'),
  ('affiliate_payouts',                'affiliateId',      'affiliates',                 NULL,       'schema.prisma only (no committed migration)'),
  ('affiliate_payouts',                'recruiterId',      'recruiters',                 NULL,       '20261106'),
  ('identity_verifications',           'affiliateId',      'affiliates',                 NULL,       '20260725'),
  ('recruiter_affiliate_links',        'affiliateId',      'affiliates',                 'RESTRICT', '20261105'),
  ('recruiter_affiliate_links',        'recruiterId',      'recruiters',                 'RESTRICT', '20261105'),
  ('recruiter_reward_ledger',          'affiliateId',      'affiliates',                 'RESTRICT', '20261105'),
  ('recruiter_reward_ledger',          'recruiterId',      'recruiters',                 'RESTRICT', '20261105'),
  ('recruiter_audit_log',              'recruiterId',      'recruiters',                 NULL,       '20261105'),
  ('affiliate_activation_codes',       'affiliateId',      'affiliates',                 NULL,       '20261107'),
  ('affiliate_activation_recoveries',  'affiliateId',      'affiliates',                 NULL,       '20261108'),
  ('affiliate_activation_recoveries',  'activationCodeId', 'affiliate_activation_codes', NULL,       '20261108'),
  ('recruiter_identity_verifications', 'recruiterId',      'recruiters',                 NULL,       '20261111')
),
fk AS (
  SELECT c.conrelid, c.conname, c.convalidated, c.confrelid,
         (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS col,
         cardinality(c.conkey) AS ncols,
         CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                            WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
  FROM pg_constraint c
  WHERE c.contype = 'f'
)
SELECT e.tbl AS "table", e.col AS "column", e.ref_tbl AS "references",
       f.conname AS "constraint",
       f.convalidated AS validated,
       f.on_delete,
       CASE WHEN to_regclass('public.' || quote_ident(e.tbl)) IS NULL THEN 'TABLE MISSING'
            WHEN f.conname IS NULL THEN 'MISSING'
            WHEN NOT f.convalidated THEN 'NOT VALIDATED'
            WHEN e.expected_on_delete IS NOT NULL AND f.on_delete <> e.expected_on_delete
              THEN 'ON DELETE ' || f.on_delete || ' (expected ' || e.expected_on_delete || ')'
            ELSE 'OK' END AS status,
       e.origin
FROM expected e
LEFT JOIN fk f
  ON f.conrelid = to_regclass('public.' || quote_ident(e.tbl))
 AND f.confrelid = to_regclass('public.' || quote_ident(e.ref_tbl))
 AND f.col = e.col AND f.ncols = 1
ORDER BY e.tbl, e.col;

-- ── 5. Phase 7 Stage F: conflicting recruiter links (read-only report, ids and counts only) ──
-- owner(X) = the recruiter of the TOPMOST linked affiliate of X's chain (a parent cycle: the one recruiter of
-- its links, none when several). The same statement as recruiterRewardService.listRecruiterOwnershipConflicts:
-- gcand / gup / grs / groots = the links without any linked ancestor on a chain with a top (the roots of every
-- network); gnet = their descendants with the root's recruiter; a link reached with another recruiter is
-- NESTED; gorph = the links no root reaches (chains ending in a parent cycle), goup = the full upward walk of
-- each, AMBIGUOUS_CYCLE when it meets two recruiters or more. Every walk uses primary-key / parentId index
-- lookups and is cycle-safe (UNION) or capped. Report only: no link is reassigned or modified.
\echo '== 5. Recruiter ownership conflicts (Phase 7 Stage F: counts + affiliate ids only) =='
SELECT to_regclass('public.recruiter_affiliate_links') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.affiliates')
                     AND attname = 'parentId' AND attnum > 0 AND NOT attisdropped) AS has_recruiter_links,
       -- attribute-number form: a missing column gives NULL (→ false), never an error
       coalesce((SELECT bool_and(has_column_privilege(a.attrelid, a.attnum, 'SELECT')) AND count(*) = 4
                 FROM pg_attribute a
                 WHERE (a.attrelid = to_regclass('public.affiliates') AND a.attname IN ('id', 'parentId')
                        OR a.attrelid = to_regclass('public.recruiter_affiliate_links') AND a.attname IN ('affiliateId', 'recruiterId'))
                   AND a.attnum > 0 AND NOT a.attisdropped), false) AS can_read_links
\gset
\if :has_recruiter_links
\if :can_read_links
WITH RECURSIVE gcand AS (
  SELECT l."affiliateId" AS "id"
  FROM "recruiter_affiliate_links" l
  JOIN "affiliates" a ON a."id" = l."affiliateId"
  WHERE NOT EXISTS (SELECT 1 FROM "recruiter_affiliate_links" pl WHERE pl."affiliateId" = a."parentId")
),
gup AS (
  SELECT s."id" AS seed, p."id", p."parentId", p.linked, p.top
  FROM unnest(ARRAY(SELECT c."id" FROM gcand c)) AS s("id")
  CROSS JOIN LATERAL (
    SELECT a."id", a."parentId",
           EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
           NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
    FROM "affiliates" a
    WHERE a."id" = (SELECT f."parentId" FROM "affiliates" f WHERE f."id" = s."id")
    OFFSET 0
  ) p
  UNION
  SELECT u.seed, p."id", p."parentId", p.linked, p.top
  FROM gup u
  CROSS JOIN LATERAL (
    SELECT a."id", a."parentId",
           EXISTS (SELECT 1 FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS linked,
           NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
    FROM "affiliates" a
    WHERE a."id" = u."parentId"
    OFFSET 0
  ) p
  WHERE NOT u.linked
),
grs AS (
  SELECT u.seed, bool_or(u.linked) AS linked, bool_or(u.top) AS top FROM gup u GROUP BY u.seed
),
groots AS (
  SELECT c."id" FROM gcand c LEFT JOIN grs ON grs.seed = c."id"
  WHERE grs.seed IS NULL OR (NOT grs.linked AND grs.top)
),
gnet AS (
  SELECT s."id", (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = s."id") AS owner, 0 AS depth
  FROM unnest(ARRAY(SELECT r."id" FROM groots r)) AS s("id")
  UNION ALL
  SELECT ch."id", n.owner, n.depth + 1
  FROM gnet n
  CROSS JOIN LATERAL (SELECT a."id" FROM "affiliates" a WHERE a."parentId" = n."id" OFFSET 0) ch
  WHERE n.depth < 1000000
),
gorph AS (
  SELECT s."id"
  FROM unnest(ARRAY(
    SELECT l."affiliateId" FROM "recruiter_affiliate_links" l
    WHERE NOT EXISTS (SELECT 1 FROM gnet n WHERE n."id" = l."affiliateId")
  )) AS s("id")
),
goup AS (
  SELECT op."id" AS seed, p."id", p."parentId", p.rid, p.top
  FROM gorph op
  CROSS JOIN LATERAL (
    SELECT a."id", a."parentId",
           (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
           NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
    FROM "affiliates" a
    WHERE a."id" = op."id"
    OFFSET 0
  ) p
  UNION
  SELECT u.seed, p."id", p."parentId", p.rid, p.top
  FROM goup u
  CROSS JOIN LATERAL (
    SELECT a."id", a."parentId",
           (SELECT x."recruiterId" FROM "recruiter_affiliate_links" x WHERE x."affiliateId" = a."id") AS rid,
           NOT EXISTS (SELECT 1 FROM "affiliates" g WHERE g."id" = a."parentId") AS top
    FROM "affiliates" a
    WHERE a."id" = u."parentId"
    OFFSET 0
  ) p
),
gagg AS (
  SELECT u.seed, bool_or(u.top) AS top, count(DISTINCT u.rid) AS nr FROM goup u GROUP BY u.seed
),
conf AS (
  SELECT n."id", 'NESTED'::text AS kind
  FROM gnet n
  JOIN "recruiter_affiliate_links" l ON l."affiliateId" = n."id"
  WHERE l."recruiterId" <> n.owner
  UNION ALL
  SELECT g.seed, 'AMBIGUOUS_CYCLE'::text FROM gagg g WHERE NOT g.top AND g.nr > 1
),
page AS (
  SELECT c."id", c.kind FROM conf c ORDER BY c."id" LIMIT 200
)
SELECT (SELECT count(*)::int FROM conf) AS conflicting_links,
       (SELECT count(*)::int FROM conf c WHERE c.kind = 'NESTED') AS nested,
       (SELECT count(*)::int FROM conf c WHERE c.kind = 'AMBIGUOUS_CYCLE') AS ambiguous_cycle,
       p."id" AS affiliate_id, p.kind
FROM (SELECT 1) one
LEFT JOIN page p ON true
ORDER BY p."id";
\else
\echo 'this role cannot SELECT affiliates("id", "parentId") and recruiter_affiliate_links("affiliateId", "recruiterId"): section 5 skipped (grant SELECT on those columns and re-run).'
\endif
\else
\echo 'recruiter_affiliate_links or affiliates."parentId" does not exist in this database: section 5 skipped.'
\endif

-- ── end: nothing was written; close the read-only transaction (SET LOCAL values end here) ────
ROLLBACK;
\echo '== done: read-only transaction rolled back =='
