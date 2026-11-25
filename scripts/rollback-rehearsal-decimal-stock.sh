#!/usr/bin/env bash
# Rehearses 20261125001000_decimal_stock: the migration applies on top of every earlier migration with stock and a sale
# already in the database and whole numbers convert exactly; while no decimal has been recorded the rollback works
# (columns back to integers, the old functions and views back, the new check gone, grants intact, sales still work) and
# the migration applies again; then decimals work (receive, sell, whole-unit products still refuse them), re-applying
# changes nothing, and the rollback REFUSES (the stock ledger is permanent history) and changes nothing.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_decimal_stock"
M=20261125001000_decimal_stock
MGR=00000000-0000-0000-0000-0000000000f1
CSH=00000000-0000-0000-0000-0000000000f2
PRD=00000000-0000-0000-0000-0000000000f3
WGT=00000000-0000-0000-0000-0000000000f4
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
sale() { # sale <product> <quantity> <amount> <key>
  q "select pos_complete_sale('$CSH','$S','[{\\\"product_id\\\":\\\"$1\\\",\\\"quantity\\\":$2}]'::jsonb,'[{\\\"method\\\":\\\"cash\\\",\\\"amount\\\":\\\"$3\\\"}]'::jsonb,null,'$4')" >/dev/null
}
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
q "insert into auth.users (id, email) values ('$MGR','mgr@test.local'), ('$CSH','csh@test.local')" >/dev/null
q "insert into user_roles (user_id, role) values ('$MGR','manager'), ('$CSH','budtender')" >/dev/null
q "insert into products (id, slug, name, category, price_rand) values ('$PRD','rh-dec-unit','Pre-roll','Pre-rolls',20)" >/dev/null
q "insert into products (id, slug, name, category, price_rand, sold_by_weight, weight_step_g) values ('$WGT','rh-dec-wgt','Flower by the gram','Flower',24.55,true,0.5)" >/dev/null
q "select receive_stock('$MGR','$PRD','B1',10,null,null,null,'rh-receive-unit')" >/dev/null
q "select receive_stock('$MGR','$WGT','W1',30,null,null,null,'rh-receive-wgt')" >/dev/null
D="$(q "select pos_upsert_drawer('$MGR',null,'Till R','Test',true)->>'drawer_id'")"
S="$(q "select pos_open_session('$CSH','$D',100,'rh-open-1')->>'session_id'")"
sale "$PRD" 2 40 rh-sale-0
echo "0. database before the migration is ready (with stock and a sale already made)"

apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select data_type || numeric_scale from information_schema.columns where table_name='inventory_batches' and column_name='qty_on_hand'")" = numeric1 ] || { echo "FAIL: stock column not numeric(12,1)"; exit 1; }
[ "$(q "select qty_on_hand::text from inventory_batches where product_id='$PRD'")" = 8.0 ] || { echo "FAIL: whole stock did not convert exactly"; exit 1; }
[ "$(q "select quantity::text from pos_sale_items limit 1")" = 2.0 ] || { echo "FAIL: old sale line changed"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.receive_stock(uuid,uuid,text,numeric,timestamptz,numeric,text,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can receive stock"; exit 1; }
[ "$(q "select has_function_privilege('anon','public._assert_stock_qty(uuid,numeric)','EXECUTE')")" = f ] || { echo "FAIL: anon can call the stock check"; exit 1; }
[ "$(q "select string_agg(privilege_type, ',') from information_schema.role_table_grants where table_name='inventory_availability' and grantee='authenticated'")" = SELECT ] || { echo "FAIL: view grants"; exit 1; }
echo "1. applied: columns are numeric(12,1), whole stock and the old sale converted exactly, grants intact"

apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" 2>&1 | tail -3; exit 1; }
[ "$(q "select data_type from information_schema.columns where table_name='inventory_batches' and column_name='qty_on_hand'")" = integer ] || { echo "FAIL: stock column not integer again"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname = '_assert_stock_qty'")" = 0 ] || { echo "FAIL: the new stock check remains"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname = 'receive_stock'")" = 1 ] || { echo "FAIL: not exactly one receive_stock"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname = 'receive_stock' and pg_get_function_identity_arguments(oid) like '%p_quantity integer%'")" = 1 ] || { echo "FAIL: old receive_stock not back"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.receive_stock(uuid,uuid,text,integer,timestamptz,numeric,text,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can receive stock after rollback"; exit 1; }
[ "$(q "select pg_get_function_result('public._product_on_hand(uuid)'::regprocedure)")" = integer ] || { echo "FAIL: _product_on_hand not integer again"; exit 1; }
[ "$(q "select count(*) from pg_class where relname in ('inventory_availability','stock_movements') and relkind='v'")" = 2 ] || { echo "FAIL: views missing"; exit 1; }
[ "$(q "select qty_on_hand::text from inventory_batches where product_id='$PRD'")" = 8 ] || { echo "FAIL: rollback changed the stock"; exit 1; }
q "select receive_stock('$MGR','$PRD','B3',3,null,null,null,'rh-receive-after')" >/dev/null || { echo "FAIL: old receive_stock does not work"; exit 1; }
sale "$PRD" 1 20 rh-sale-2 || { echo "FAIL: a whole-number sale does not work after rollback"; exit 1; }
[ "$(q "select _product_on_hand('$PRD')::text")" = 10 ] || { echo "FAIL: stock after rollback and a sale is wrong"; exit 1; }
echo "2. rolled back (no decimals yet): integers again, old functions and views back, new check gone, grants intact, stock and sales work"

apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
[ "$(q "select _product_on_hand('$PRD')::text")" = 10.0 ] || { echo "FAIL: re-apply changed the stock"; exit 1; }
echo "3. re-applied after rollback"

q "select receive_stock('$MGR','$WGT','W2',0.4,null,null,null,'rh-receive-dec')" >/dev/null
[ "$(q "select _product_on_hand('$WGT')::text")" = 30.4 ] || { echo "FAIL: decimal stock not held"; exit 1; }
sale "$WGT" 1.5 36.83 rh-sale-1 || { echo "FAIL: decimal sale refused"; exit 1; }
[ "$(q "select _product_on_hand('$WGT')::text")" = 28.9 ] || { echo "FAIL: decimal sale took the wrong stock"; exit 1; }
if q "select receive_stock('$MGR','$PRD','B2',2.5,null,null,null,'rh-receive-bad')" >/dev/null 2>&1; then echo "FAIL: a pre-roll was received as 2.5"; exit 1; fi
echo "4. decimals work: 0.4 g received, 1.5 g sold at R36.83, a whole-unit product refuses 2.5"

apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select _product_on_hand('$WGT')::text")" = 28.9 ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "5. re-applying changes nothing"

if apply "$ROOT/supabase/rollbacks/${M}_rollback.sql"; then echo "FAIL: rollback ran while decimals exist"; exit 1; fi
[ "$(q "select data_type from information_schema.columns where table_name='inventory_batches' and column_name='qty_on_hand'")" = numeric ] || { echo "FAIL: the refused rollback changed the schema"; exit 1; }
[ "$(q "select _product_on_hand('$WGT')::text")" = 28.9 ] || { echo "FAIL: the refused rollback changed the stock"; exit 1; }
echo "6. rollback refused once decimal stock exists, and changed nothing"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: decimal_stock rollback rehearsal"
