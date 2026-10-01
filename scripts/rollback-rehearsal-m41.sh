#!/usr/bin/env bash
# Rehearses the checkout-migration rollback on a scratch DB: records the Milestone 4 definitions of the
# four patched functions, applies the checkout migration, rolls it back, proves the originals are
# restored byte-for-byte and the new objects are gone, then re-applies. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_m41"
MIG="20260930002000_checkout_orders"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
HASH="select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('redeem_loyalty_points','accrue_order_loyalty','reorder_check','create_reorder')"

run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | grep -v "$MIG"); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
before=$(run "$P -At -d $DB -c \"$HASH\"")
echo "1. M4 schema built; function hash $before"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1
changed=$(run "$P -At -d $DB -c \"$HASH\"")
[ "$changed" != "$before" ] && echo "2. checkout migration applied (functions patched)" || { echo "FAIL: functions unchanged"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${MIG}_rollback.sql" >/dev/null
after=$(run "$P -At -d $DB -c \"$HASH\"")
[ "$after" = "$before" ] && echo "3. rollback restored the M4 functions byte-for-byte" || { echo "FAIL: functions differ after rollback"; exit 1; }
left=$(run "$P -At -d $DB -c \"select (select count(*) from information_schema.tables where table_schema='public' and table_name='delivery_options') + (select count(*) from information_schema.columns where table_schema='public' and table_name='orders' and column_name in ('delivery_method','delivery_fee_rand','delivery_address','payment_method')) + (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('checkout_quote','checkout_place_order','_checkout_apply_delivery'))\"")
echo "4. leftover checkout objects: $left"
[ "$left" = 0 ] || { echo "FAIL: leftovers"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1 && echo "5. migration re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'"
