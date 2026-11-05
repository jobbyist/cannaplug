#!/usr/bin/env bash
# Rehearses 20261105003000_stock_takes: the migration applies on top of every earlier migration, the tables have RLS
# and no browser write grants, the functions are service-role only, a count posts and moves stock, re-applying changes
# nothing, the rollback removes the tables and functions but keeps the stock already moved, and the migration applies
# again afterwards. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_stock_takes"
M=20261105003000_stock_takes
MGR=00000000-0000-0000-0000-0000000000c1
PRD=00000000-0000-0000-0000-0000000000c2
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
[ "$(q "select count(*) from pg_class where relname in ('stock_takes','stock_take_lines') and relrowsecurity")" = 2 ] || { echo "FAIL: tables missing or RLS off"; exit 1; }
[ "$(q "select count(*) from information_schema.role_table_grants where table_name in ('stock_takes','stock_take_lines') and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'")" = 0 ] || { echo "FAIL: browser write grants"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.stock_take_post(uuid,uuid,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can post"; exit 1; }
echo "1. applied: tables with RLS and read-only for staff, service-role functions"
q "insert into auth.users (id, email) values ('$MGR','mgr@test.local')" >/dev/null
q "insert into user_roles (user_id, role) values ('$MGR','manager')" >/dev/null
q "insert into products (id, slug, name, category, price_rand) values ('$PRD','rh-st','Rehearsal','Flower',10)" >/dev/null
q "select receive_stock('$MGR','$PRD','B1',10,null,null,null,'rh-receive-1')" >/dev/null
T="$(q "select stock_take_start('$MGR',null,null,'rh-start-1')->>'stock_take_id'")"
q "select stock_take_record_count('$MGR','$T','$PRD',7,'rh-count-1')" >/dev/null
q "select stock_take_post('$MGR','$T','rh-post-1')" >/dev/null
[ "$(q "select _product_on_hand('$PRD')")" = 7 ] || { echo "FAIL: posting did not set stock to the count"; exit 1; }
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select status from stock_takes where id='$T'")" = posted ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "2. a count of 7 against 10 on hand posts as 7; re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_class where relname in ('stock_takes','stock_take_lines')")" = 0 ] || { echo "FAIL: tables remain"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname like 'stock_take_%' or proname in ('stock_quick_adjust','stock_receive_delivery','_stock_move_product','_product_on_hand')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select sum(qty_on_hand) from inventory_batches where product_id='$PRD'")" = 7 ] || { echo "FAIL: rollback changed stock"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('receive_stock','adjust_stock')")" = 2 ] || { echo "FAIL: existing stock functions were touched"; exit 1; }
echo "3. rolled back: tables and functions gone; stock already moved is kept; receive/adjust untouched"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: stock_takes rollback rehearsal"
