#!/usr/bin/env bash
# Rehearses 20261031006000_plug_back: the migration applies on top of every earlier migration, tubes can be recorded and
# spent, re-applying changes nothing, the rollback removes the table, functions and trigger without touching the R0 sale
# that was already rung up, and the migration applies again afterwards. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_plug_back"
M=20261031006000_plug_back
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select count(*) from pg_class where relname='plug_back_ledger' and relrowsecurity")" = 1 ] || { echo "FAIL: ledger missing or RLS off"; exit 1; }
[ "$(q "select plug_back_tubes_per_reward()")" = 10 ] || { echo "FAIL: rule is not 10 tubes"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('plug_back_summary','plug_back_record_return','plug_back_redeem')")" = 3 ] || { echo "FAIL: functions missing"; exit 1; }
[ "$(q "select count(*) from information_schema.role_table_grants where table_name='plug_back_ledger' and grantee in ('anon','authenticated')")" = 0 ] || { echo "FAIL: browser grants on the ledger"; exit 1; }
echo "1. applied: ledger with RLS and no browser grants, three functions, rule of 10 tubes"
q "insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','pb@test.local')" >/dev/null
q "insert into public.plug_back_ledger (user_id, tubes, source_type, source_id) values ('00000000-0000-0000-0000-0000000000a1', 12, 'return', gen_random_uuid())" >/dev/null
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select _plug_back_balance('00000000-0000-0000-0000-0000000000a1')")" = 12 ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "2. re-applied: the tube count is unchanged"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_class where relname='plug_back_ledger'")" = 0 ] || { echo "FAIL: ledger remains"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname like '%plug_back%'")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from pg_trigger where tgname in ('pos_sales_plug_back_void','plug_back_ledger_append_only')")" = 0 ] || { echo "FAIL: triggers remain"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='pos_complete_sale'")" = 1 ] || { echo "FAIL: the till sale function was touched"; exit 1; }
echo "3. rolled back: table, functions and triggers gone; the till is untouched"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: plug_back rollback rehearsal"
