#!/usr/bin/env bash
# Rehearses 20261027004000_email_budget: apply all -> budget and no ID-received email -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_email_budget"
M=20261027004000_email_budget
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select (public.email_budget_status()->>'limit')::int")" = 100 ] || { echo "FAIL: budget"; exit 1; }
[ "$(q "select public._email_tier('staff_id_review')")" = 0 ] || { echo "FAIL: tier"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.email_budget_status()','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
echo "1. applied; daily budget in place, service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select to_regprocedure('public.email_budget_status()') is null")" = t ] || { echo "FAIL: function still present"; exit 1; }
[ "$(q "select position('id_submitted' in pg_get_functiondef('public._notify_id_verification()'::regprocedure)) > 0")" = t ] || { echo "FAIL: old ID emails not restored"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
