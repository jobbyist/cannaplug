#!/usr/bin/env bash
# Disposable local PostgreSQL for migration + concurrency tests.
#   scripts/test-db.sh start   -> boots cluster, applies bootstrap + all migrations, prints URL
#   scripts/test-db.sh reset   -> drops/recreates the test database and re-applies migrations
#   scripts/test-db.sh stop
# Requires PostgreSQL server binaries (PG_BIN); runs the server as the `postgres` OS user when root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PGDATA_DIR="${TEST_PGDATA:-/var/tmp/cannaplug-pgdata}"
PORT="${TEST_PGPORT:-54329}"
DB="cannaplug_test"

run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
psqlx() { run "$PG_BIN/psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $PORT $*"; }

case "${1:-start}" in
  start|reset)
    if [ ! -d "$PGDATA_DIR" ]; then
      mkdir -p "$PGDATA_DIR"
      if [ "$(id -u)" = 0 ]; then chown postgres "$PGDATA_DIR"; fi
      run "$PG_BIN/initdb -D $PGDATA_DIR -A trust -U postgres >/dev/null"
    fi
    run "$PG_BIN/pg_ctl -D $PGDATA_DIR -o '-p $PORT -k /tmp -c fsync=off -c max_connections=200' -l $PGDATA_DIR/log -w start >/dev/null" || true
    psqlx "-U postgres -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)'"
    psqlx "-U postgres -d postgres -c 'CREATE DATABASE $DB'"
    psqlx "-U postgres -d $DB -f $ROOT/supabase/tests/local/bootstrap.sql"
    for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
      psqlx "-U postgres -d $DB -f $f" >/dev/null
    done
    echo "postgres://postgres@127.0.0.1:$PORT/$DB"
    ;;
  stop) run "$PG_BIN/pg_ctl -D $PGDATA_DIR -m fast stop" ;;
  *) echo "usage: $0 start|reset|stop" >&2; exit 2 ;;
esac
