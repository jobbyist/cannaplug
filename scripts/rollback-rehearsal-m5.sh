#!/usr/bin/env bash
# Rehearses the ID-verification rollback on a scratch DB: records the checkout-migration definitions of the
# two gated functions and the customer_verification shape, applies the migration, rolls it back, proves the
# originals are restored byte-for-byte and the new objects are gone, then re-applies.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_m5"
MIG="20260930003000_id_verification"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
FN="select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('checkout_place_order','create_reorder')"
POLS="select string_agg(policyname, ',' order by policyname) from pg_policies where tablename='customer_verification'"
COLS="select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='customer_verification'"

run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | grep -v "$MIG"); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
fn0=$(run "$P -At -d $DB -c \"$FN\""); pol0=$(run "$P -At -d $DB -c \"$POLS\""); col0=$(run "$P -At -d $DB -c \"$COLS\"")
echo "1. checkout-era schema built"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1
[ "$(run "$P -At -d $DB -c \"$FN\"")" != "$fn0" ] && echo "2. migration applied (functions gated)" || { echo "FAIL: functions unchanged"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${MIG}_rollback.sql" >/dev/null
[ "$(run "$P -At -d $DB -c \"$FN\"")" = "$fn0" ] && echo "3. rollback restored both functions byte-for-byte" || { echo "FAIL: functions differ"; exit 1; }
[ "$(run "$P -At -d $DB -c \"$POLS\"")" = "$pol0" ] && echo "4. policies restored" || { echo "FAIL: policies differ"; exit 1; }
[ "$(run "$P -At -d $DB -c \"$COLS\"")" = "$col0" ] && echo "5. columns restored" || { echo "FAIL: columns differ"; exit 1; }
left=$(run "$P -At -d $DB -c \"select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('verification_submit','verification_review','verification_log_document_view','_require_verified_member')\"")
[ "$left" = 0 ] && echo "6. verification functions gone" || { echo "FAIL: leftovers $left"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1 && echo "7. migration re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'"
