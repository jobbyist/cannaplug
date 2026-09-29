#!/usr/bin/env bash
# Rehearses the Milestone 3 rollback on a scratch database, then re-applies the migration.
# Requires the local test cluster (scripts/test-db.sh start). Never touches cannaplug_test.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"

run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql"
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
echo "1. all migrations applied"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/20260929010000_pos_atomic_inventory_rollback.sql" >/dev/null
echo "2. rollback executed"
left=$(run "$P -At -d $DB -c \"select count(*) from information_schema.tables where table_schema='public' and (table_name like 'pos_%' or table_name in ('stock_reservations','loyalty_ledger','payment_events','cash_drawers','operation_idempotency'))\"")
echo "3. leftover M3 tables: $left"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/20260929010000_pos_atomic_inventory.sql" >/dev/null 2>&1 && echo "4. migration re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'"
