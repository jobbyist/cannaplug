#!/usr/bin/env bash
# Rehearses 20261028006000_pos_zero_total_sales: apply all -> R0 sale accepted -> roll back -> R0 refused -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_pos_zero_total"
M=20261028006000_pos_zero_total_sales
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select pg_get_constraintdef(oid) from pg_constraint where conname='pos_sales_total_check'")" = "CHECK ((total >= (0)::numeric))" ] || { echo "FAIL: constraint not relaxed"; exit 1; }
echo "1. applied; a sale may total R0"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select pg_get_constraintdef(oid) from pg_constraint where conname='pos_sales_total_check'")" = "CHECK ((total > (0)::numeric))" ] || { echo "FAIL: constraint not restored"; exit 1; }
[ "$(q "select position('NOT BETWEEN 1 AND 8' in pg_get_functiondef(p.oid)) > 0 from pg_proc p where proname='pos_complete_sale'")" = t ] || { echo "FAIL: function not restored"; exit 1; }
echo "2. rolled back; sales must total above R0 again"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select position('NOT BETWEEN 0 AND 8' in pg_get_functiondef(p.oid)) > 0 from pg_proc p where proname='pos_complete_sale'")" = t ] || { echo "FAIL: not re-applied"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
