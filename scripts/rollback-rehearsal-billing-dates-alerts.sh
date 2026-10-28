#!/usr/bin/env bash
# Rehearses 20261029002000_billing_dates_alerts: apply all -> eight accounts, ID-credit alert -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_billing_dates_alerts"
M=20261029002000_billing_dates_alerts
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select count(*) from public.billing_accounts")" = 8 ] || { echo "FAIL: eight accounts expected"; exit 1; }
q "insert into public.id_credit_ledger (kind, credits, reserved_delta, note, idempotency_key) values ('reserve', 0, 350, 'rehearsal', 'rehearsal:low')" >/dev/null
[ "$(q "select count(*) from public.team_notifications where source_key = 'alert:id-credits' and status = 'published'")" = 1 ] || { echo "FAIL: ID-credit alert missing"; exit 1; }
echo "1. applied; eight accounts; a low balance publishes the ID-credit alert"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from public.billing_accounts")" = 6 ] || { echo "FAIL: accounts after rollback"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('billing_next_due','billing_due_alerts_refresh','team_alert_id_credits')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name = 'billing_accounts' and column_name in ('recur_kind','anchor_date')")" = 0 ] || { echo "FAIL: columns remain"; exit 1; }
[ "$(q "select count(*) from public.team_notifications where source_key = 'alert:id-credits'")" = 0 ] || { echo "FAIL: alert remains"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from public.billing_accounts")" = 8 ] || { echo "FAIL: accounts after re-apply"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
