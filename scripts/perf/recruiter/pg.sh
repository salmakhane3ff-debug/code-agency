#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/perf/recruiter/pg.sh — the DISPOSABLE PostgreSQL 16 cluster of the Phase 6
# Part 5a recruiter performance baseline (init / start / stop / restart / status /
# settings / destroy / psql).
#
# SAFETY GUARD: this script only ever touches ONE fixed, throwaway location:
#   data /tmp/p5a-pg/data   socket /tmp/p5a-pg/sock   logs /tmp/p5a-pg/log   port 55510
# The server listens on the Unix socket ONLY (listen_addresses = ''), is owned by the
# `postgres` OS user (directories mode 700) and uses trust authentication on that socket.
# Nothing here reads .env, DATABASE_URL or any other database; no other path is written
# (except an explicit output file given to `settings`). `destroy` removes /tmp/p5a-pg only.
#
# Settings: PostgreSQL 16 defaults EXCEPT the benchmark settings below (written to
# data/p5a.conf, included at the end of postgresql.conf):
#   shared_preload_libraries = 'pg_stat_statements', pg_stat_statements.track = all,
#   track_io_timing = on, log_lock_waits = on, deadlock_timeout = 100ms, logging_collector = on
# plus the location settings that make the cluster disposable and private:
#   listen_addresses = '', port = 55510, unix_socket_directories = '/tmp/p5a-pg/sock',
#   log_directory = '/tmp/p5a-pg/log'.
# initdb: --encoding=UTF8 --locale=C.UTF-8 (this container has no other UTF-8 locale; the
# initdb default here would be SQL_ASCII), --auth=trust, superuser `postgres`.
#
# Usage: bash scripts/perf/recruiter/pg.sh <init|start|stop|restart|status|settings [file]|destroy|psql [args…]>
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PGBIN=/usr/lib/postgresql/16/bin
ROOT=/tmp/p5a-pg
DATA=$ROOT/data
SOCK=$ROOT/sock
LOGD=$ROOT/log
PORT=55510

as_pg() { runuser -u postgres -- "$@"; }
psql_pg() { "$PGBIN/psql" -X -h "$SOCK" -p "$PORT" -U postgres "$@"; }
is_running() { [ -f "$DATA/postmaster.pid" ] && as_pg "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; }
wait_ready() {
  for _ in $(seq 1 120); do
    if "$PGBIN/pg_isready" -q -h "$SOCK" -p "$PORT" -U postgres; then return 0; fi
    sleep 0.5
  done
  echo "pg.sh: server did not become ready" >&2
  return 1
}

cmd=${1:-status}
case "$cmd" in
  init)
    if [ -e "$DATA/PG_VERSION" ]; then echo "pg.sh: $DATA already initialised (use destroy first)" >&2; exit 1; fi
    mkdir -p "$DATA" "$SOCK" "$LOGD"
    chown postgres:postgres "$ROOT" "$DATA" "$SOCK" "$LOGD"
    chmod 700 "$ROOT" "$DATA" "$SOCK" "$LOGD"
    as_pg "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >"$LOGD/initdb.log" 2>&1
    chown postgres:postgres "$LOGD/initdb.log"
    cat >"$DATA/p5a.conf" <<'CONF'
# Phase 6 Part 5a disposable benchmark cluster. Everything not listed here is the
# PostgreSQL 16 default. Written by scripts/perf/recruiter/pg.sh init.
listen_addresses = ''
port = 55510
unix_socket_directories = '/tmp/p5a-pg/sock'
logging_collector = on
log_directory = '/tmp/p5a-pg/log'
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
track_io_timing = on
log_lock_waits = on
deadlock_timeout = 100ms
CONF
    chown postgres:postgres "$DATA/p5a.conf"
    chmod 600 "$DATA/p5a.conf"
    printf "\n# Phase 6 Part 5a benchmark settings\ninclude 'p5a.conf'\n" >>"$DATA/postgresql.conf"
    echo "pg.sh: initialised $DATA (log $LOGD/initdb.log)"
    ;;
  start)
    if is_running; then echo "pg.sh: already running"; exit 0; fi
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -l "$LOGD/pg_ctl.log" -w -t 120 start >/dev/null
    wait_ready
    echo "pg.sh: started (socket $SOCK, port $PORT)"
    ;;
  stop)
    if ! is_running; then echo "pg.sh: not running"; exit 0; fi
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -m fast -w -t 120 stop >/dev/null
    echo "pg.sh: stopped"
    ;;
  restart)
    as_pg "$PGBIN/pg_ctl" -D "$DATA" -l "$LOGD/pg_ctl.log" -m fast -w -t 120 restart >/dev/null
    wait_ready
    echo "pg.sh: restarted"
    ;;
  status)
    as_pg "$PGBIN/pg_ctl" -D "$DATA" status || true
    if is_running; then
      psql_pg -d postgres -At -c "SELECT version()"
      psql_pg -d postgres -At -c "SELECT datname || ' ' || pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE NOT datistemplate OR datname LIKE 'p5a%' ORDER BY 1"
    fi
    ;;
  settings)
    out=${2:-/dev/stdout}
    psql_pg -d postgres -c "COPY (SELECT name, setting, unit, source, boot_val, reset_val, pending_restart FROM pg_settings ORDER BY name) TO STDOUT WITH CSV HEADER" >"$out"
    [ "$out" != /dev/stdout ] && echo "pg.sh: pg_settings snapshot written to $out"
    ;;
  destroy)
    if is_running; then as_pg "$PGBIN/pg_ctl" -D "$DATA" -m fast -w -t 120 stop >/dev/null || true; fi
    if [ "$ROOT" = /tmp/p5a-pg ] && [ -d "$ROOT" ]; then rm -rf -- /tmp/p5a-pg; fi
    echo "pg.sh: destroyed /tmp/p5a-pg"
    ;;
  psql)
    shift
    exec "$PGBIN/psql" -X -h "$SOCK" -p "$PORT" -U postgres "$@"
    ;;
  *)
    echo "usage: pg.sh <init|start|stop|restart|status|settings [file]|destroy|psql [args…]>" >&2
    exit 2
    ;;
esac
