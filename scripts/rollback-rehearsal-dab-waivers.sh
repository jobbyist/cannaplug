#!/usr/bin/env bash
# Rehearses 20261127012000_dab_waivers: applies on top of every earlier migration, the functions are service-role only,
# re-applying changes nothing, the rollback removes the table, functions and product flag while keeping sales,
# and the migration applies again afterwards.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_waiver"
M=20261127012000_dab_waivers
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
[ "$(q "select has_function_privilege('authenticated','public.dab_waiver_get(uuid,uuid)','EXECUTE')")" = f ] || { echo "FAIL: browsers can read waivers"; exit 1; }
[ "$(q "select has_table_privilege('authenticated','public.dab_waivers','SELECT')")" = f ] || { echo "FAIL: browsers can read the table"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='products' and column_name='requires_waiver'")" = 1 ] || { echo "FAIL: flag missing"; exit 1; }
echo "1. applied: service-role only, products can be flagged"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
echo "2. re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname like 'dab_waiver%'")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select to_regclass('public.dab_waivers') is null")" = t ] || { echo "FAIL: table remains"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='products' and column_name='requires_waiver'")" = 0 ] || { echo "FAIL: flag remains"; exit 1; }
echo "3. rolled back: table, functions and flag gone"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: dab_waivers rollback rehearsal"
