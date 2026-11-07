#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/perf/recruiter/schema.sh — builds the SCHEMA-ONLY database p5a_base on the
# disposable cluster (scripts/perf/recruiter/pg.sh) and proves it has zero drift against
# prisma/schema.prisma at HEAD. The scale templates p5a_1k / p5a_10k / p5a_100k are created
# from it (CREATE DATABASE … TEMPLATE p5a_base) by generate.mjs.
#
#   1. git show 3607da3:prisma/schema.prisma            → $WORK/base-3607da3.prisma
#   2. prisma migrate diff --from-empty --to-schema-datamodel <that> --script
#                                                        → $WORK/base-3607da3.sql
#   3. (re)create p5a_base, apply that SQL (psql, ON_ERROR_STOP)
#   4. apply the 7 recruiter migrations 20261105 … 20261111 in order (they are re-runnable:
#      the 3607da3 datamodel already contains the recruiter tables of 20261105–20261109)
#   5. prisma migrate diff --from-url <p5a_base> --to-schema-datamodel prisma/schema.prisma
#      --script --exit-code   → must print an empty migration (exit 0)
#   6. writes $MANIFESTS/schema.json (sha256 of every input, per-migration notices, drift result)
#
# SAFETY GUARD: the only database URL used is the disposable one
#   postgresql://postgres@localhost:55510/p5a_base?host=/tmp/p5a-pg/sock
# set in THIS process environment only. It refuses to run if any .env file exists in the repo
# root, prisma/ or the work directory (so the Prisma CLI can never load one), and runs the
# Prisma CLI from the scratch work directory (the repo's prisma.config.ts, which imports
# dotenv, is never loaded). It only drops/creates the database p5a_base. No repo file is written.
#
# Usage: bash scripts/perf/recruiter/schema.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO=/home/user/code-agency
SCRATCH=/tmp/claude-0/-home-user-code-agency/de929ac0-e87f-5467-b8d5-bba7b3f36bd6/scratchpad/p5a
WORK=$SCRATCH/work
MANIFESTS=$SCRATCH/manifests
LOGS=$SCRATCH/logs
PGBIN=/usr/lib/postgresql/16/bin
SOCK=/tmp/p5a-pg/sock
PORT=55510
DB=p5a_base
BASE_COMMIT=3607da3
MIGRATIONS=(
  20261105_affiliate_recruiter_system
  20261106_recruiter_rewards_withdrawals
  20261107_affiliate_activation_codes
  20261108_affiliate_activation_recovery
  20261109_account_token_version
  20261110_recruiter_reward_cycles
  20261111_recruiter_identity_verifications
)
PRISMA="$REPO/node_modules/.bin/prisma"

for f in "$REPO/.env" "$REPO/prisma/.env" "$WORK/.env"; do
  if [ -e "$f" ]; then echo "schema.sh: refusing — $f exists (no .env may be readable by the Prisma CLI)" >&2; exit 2; fi
done
"$PGBIN/pg_isready" -q -h "$SOCK" -p "$PORT" -U postgres || { echo "schema.sh: the p5a cluster is not running (pg.sh start)" >&2; exit 2; }
mkdir -p "$WORK" "$MANIFESTS" "$LOGS"

export DATABASE_URL="postgresql://postgres@localhost:${PORT}/${DB}?host=${SOCK}"
export CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
PSQL=("$PGBIN/psql" -X -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
sha() { sha256sum "$1" | cut -d' ' -f1; }
t0=$(date +%s.%N)

# 1–2. Base SQL regenerated from the 3607da3 datamodel.
git -C "$REPO" show "$BASE_COMMIT:prisma/schema.prisma" >"$WORK/base-$BASE_COMMIT.prisma"
(cd "$WORK" && "$PRISMA" migrate diff --from-empty --to-schema-datamodel "$WORK/base-$BASE_COMMIT.prisma" --script) \
  >"$WORK/base-$BASE_COMMIT.sql" 2>"$LOGS/schema-basediff.err"

# 3. Fresh p5a_base (never a template or a clone).
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
"${PSQL[@]}" -d postgres -c "CREATE DATABASE $DB"
"${PSQL[@]}" -d "$DB" -f "$WORK/base-$BASE_COMMIT.sql" >"$LOGS/schema-base-apply.log" 2>&1

# 4. The seven recruiter migrations, in order.
mig_json=""
for m in "${MIGRATIONS[@]}"; do
  f="$REPO/prisma/migrations/$m/migration.sql"
  "${PSQL[@]}" -d "$DB" -f "$f" >"$LOGS/schema-$m.log" 2>&1
  notices=$(grep -c NOTICE "$LOGS/schema-$m.log" || true)
  mig_json="$mig_json{\"name\":\"$m\",\"sha256\":\"$(sha "$f")\",\"notices\":$notices,\"log\":\"$LOGS/schema-$m.log\"},"
  echo "schema.sh: applied $m ($notices notices)"
done

# 5. Drift against HEAD's datamodel (exit code 2 = differences).
set +e
(cd "$WORK" && "$PRISMA" migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel "$REPO/prisma/schema.prisma" --script --exit-code) \
  >"$WORK/drift-$DB.sql" 2>"$LOGS/schema-drift.err"
drift_rc=$?
set -e
drift_text=$(grep -v '^[[:space:]]*$' "$WORK/drift-$DB.sql" | tr '\n' ' ' | sed 's/"/\\"/g')
t1=$(date +%s.%N)
empty=false
if [ "$drift_rc" -eq 0 ] && grep -q "This is an empty migration" "$WORK/drift-$DB.sql"; then empty=true; fi

cat >"$MANIFESTS/schema.json" <<JSON
{
  "database": "$DB",
  "headCommit": "$(git -C "$REPO" rev-parse HEAD)",
  "baseCommit": "$BASE_COMMIT",
  "baseDatamodel": "$WORK/base-$BASE_COMMIT.prisma",
  "baseDatamodelSha256": "$(sha "$WORK/base-$BASE_COMMIT.prisma")",
  "baseSql": "$WORK/base-$BASE_COMMIT.sql",
  "baseSqlSha256": "$(sha "$WORK/base-$BASE_COMMIT.sql")",
  "baseSqlLines": $(wc -l <"$WORK/base-$BASE_COMMIT.sql"),
  "migrations": [${mig_json%,}],
  "headSchemaSha256": "$(sha "$REPO/prisma/schema.prisma")",
  "driftExitCode": $drift_rc,
  "driftOutput": "$drift_text",
  "driftEmpty": $empty,
  "prismaCli": "$("$PRISMA" --version 2>/dev/null | awk '/^prisma /{print $3}')",
  "postgres": "$("$PGBIN/psql" -X -h "$SOCK" -p "$PORT" -U postgres -d postgres -At -c 'SHOW server_version')",
  "seconds": $(echo "$t1 - $t0" | bc),
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
echo "schema.sh: drift exit=$drift_rc empty=$empty → $MANIFESTS/schema.json"
[ "$empty" = true ] || { echo "schema.sh: DRIFT DETECTED (see $WORK/drift-$DB.sql)" >&2; exit 1; }
