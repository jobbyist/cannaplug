#!/usr/bin/env bash
# Rehearses 20261027002000_id_check_credits: apply all -> a new member is charged 3 credits -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_id_credits"
M=20261027002000_id_check_credits
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select available || '/' || reserved from public._id_credit_balance()")" = "400/558" ] || { echo "FAIL: wrong opening balance"; exit 1; }
q "insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'rh@test.local')" >/dev/null
q "insert into public.customer_verification (user_id, status, document_type, document_path, declared_dob, submitted_at, attempt_count) values ('00000000-0000-0000-0000-0000000000c1', 'pending', 'sa_id', '00000000-0000-0000-0000-0000000000c1/00000000-0000-0000-0000-000000000001.jpg', '1990-01-01', now(), 1)" >/dev/null
[ "$(q "select available from public._id_credit_balance()")" = 397 ] || { echo "FAIL: member not charged"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.id_credits_top_up(uuid,integer,text,text)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
echo "1. applied; 400 + 558 reserved, a new member costs 3, service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select to_regclass('public.id_credit_ledger') is null")" = t ] || { echo "FAIL: ledger still present"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
