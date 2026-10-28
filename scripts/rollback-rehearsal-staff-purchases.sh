#!/usr/bin/env bash
# Rehearses 20261028008000_staff_purchases: apply all -> a staff sale is discounted -> roll back (refused while one
# exists, allowed once none do) -> the old behaviour is back -> re-apply. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_staff"
M=20261028008000_staff_purchases
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select public.staff_purchase_percent()")" = 20 ] || { echo "FAIL: rate"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_schema='public' and column_name='staff_purchase' and table_name in ('orders','pos_sales')")" = 2 ] || { echo "FAIL: columns"; exit 1; }
echo "1. applied; rate 20 and staff columns on orders and pos_sales"
# A recorded staff purchase blocks the rollback.
run "$P -d $DB -c \"insert into auth.users(id,email) values ('00000000-0000-0000-0000-0000000000a1','a@t.l')\"" >/dev/null 2>&1
run "$P -d $DB -c \"insert into public.orders (user_id, contact_name, contact_phone, total_rand, staff_purchase, staff_discount_rand) values ('00000000-0000-0000-0000-0000000000a1','T','0820000000',80,true,20)\"" >/dev/null 2>&1 || { echo "FAIL: fixture"; exit 1; }
if run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1; then echo "FAIL: rollback should be refused"; exit 1; fi
echo "2. rollback refused while a staff purchase exists"
q "delete from public.orders where staff_purchase" >/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_schema='public' and column_name='staff_purchase'")" = 0 ] || { echo "FAIL: columns remain"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('staff_purchase_percent','_is_staff','checkout_quote_for','pos_customer_search','_sales_report_staff')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('checkout_place_order','redeem_loyalty_points','pos_complete_sale','sales_report')")" -ge 4 ] || { echo "FAIL: old functions missing"; exit 1; }
echo "3. rolled back; previous functions restored"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
