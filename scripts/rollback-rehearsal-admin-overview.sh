#!/usr/bin/env bash
# Rehearses 20261028005000_admin_overview_attention: apply all -> functions and columns exist -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_admin_overview"
M=20261028005000_admin_overview_attention
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select count(*) from pg_proc where proname in ('admin_overview','admin_customers_page','admin_attention_counts','team_alerts_refresh','admin_set_order_archived')")" = 5 ] || { echo "FAIL: functions missing"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='orders' and column_name='archived_at'")" = 1 ] || { echo "FAIL: archived_at missing"; exit 1; }
echo "1. applied; functions and columns present"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('admin_overview','admin_customers_page','admin_attention_counts','team_alerts_refresh','admin_set_order_archived')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where (table_name='orders' and column_name='archived_at') or (table_name='team_notifications' and column_name='source_key')")" = 0 ] || { echo "FAIL: columns remain"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='staff_directory'")" = 1 ] || { echo "FAIL: staff_directory lost"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='admin_overview'")" = 1 ] || { echo "FAIL: not re-applied"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
