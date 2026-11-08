#!/usr/bin/env bash
# Rehearses 20261108002000_pos_custom_items: the migration applies on top of every earlier migration (including a sale
# already made), the till sells a custom line without touching stock or the product list, re-applying changes nothing,
# the rollback stops custom lines but keeps the sale already made, and the migration applies again afterwards.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_pos_custom_items"
M=20261108002000_pos_custom_items
MGR=00000000-0000-0000-0000-0000000000e1
CSH=00000000-0000-0000-0000-0000000000e2
PRD=00000000-0000-0000-0000-0000000000e3
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
q "insert into auth.users (id, email) values ('$MGR','mgr@test.local'), ('$CSH','csh@test.local')" >/dev/null
q "insert into user_roles (user_id, role) values ('$MGR','manager'), ('$CSH','budtender')" >/dev/null
q "insert into products (id, slug, name, category, price_rand) values ('$PRD','rh-ci','Rehearsal','Flower',10)" >/dev/null
q "select receive_stock('$MGR','$PRD','B1',10,null,null,null,'rh-receive-1')" >/dev/null
D="$(q "select pos_upsert_drawer('$MGR',null,'Till R','Test',true)->>'drawer_id'")"
S="$(q "select pos_open_session('$CSH','$D',100,'rh-open-1')->>'session_id'")"
q "select pos_complete_sale('$CSH','$S','[{\\\"product_id\\\":\\\"$PRD\\\",\\\"quantity\\\":1}]'::jsonb,'[{\\\"method\\\":\\\"cash\\\",\\\"amount\\\":\\\"10\\\"}]'::jsonb,null,'rh-sale-0')" >/dev/null
echo "0. database before the migration is ready (with a sale already made)"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.pos_complete_sale(uuid,uuid,jsonb,jsonb,uuid,text,jsonb,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can sell"; exit 1; }
[ "$(q "select count(*) from pos_sale_items where is_custom")" = 0 ] || { echo "FAIL: old lines marked custom"; exit 1; }
echo "1. applied: old sale lines untouched, function still service-role only"
q "select pos_complete_sale('$CSH','$S','[{\\\"custom\\\":{\\\"name\\\":\\\"Gift wrap\\\",\\\"price\\\":\\\"15\\\"},\\\"quantity\\\":2},{\\\"custom\\\":{\\\"name\\\":\\\"Delivery\\\",\\\"price\\\":\\\"30\\\"},\\\"quantity\\\":1},{\\\"product_id\\\":\\\"$PRD\\\",\\\"quantity\\\":1}]'::jsonb,'[{\\\"method\\\":\\\"cash\\\",\\\"amount\\\":\\\"70\\\"}]'::jsonb,null,'rh-sale-1')" >/dev/null || { echo "FAIL: custom sale refused"; exit 1; }
[ "$(q "select count(*) from pos_sale_items where is_custom")" = 2 ] || { echo "FAIL: custom lines not stored"; exit 1; }
[ "$(q "select sum(qty_on_hand) from inventory_batches where product_id='$PRD'")" = 8 ] || { echo "FAIL: stock wrong"; exit 1; }
[ "$(q "select count(*) from products where name in ('Gift wrap','Delivery')")" = 0 ] || { echo "FAIL: product created"; exit 1; }
echo "2. a sale with two custom lines and a product: custom lines stored, stock only for the product, no product created"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from pos_sale_items where is_custom")" = 2 ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "3. re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
if q "select pos_complete_sale('$CSH','$S','[{\\\"custom\\\":{\\\"name\\\":\\\"X\\\",\\\"price\\\":\\\"5\\\"},\\\"quantity\\\":1}]'::jsonb,'[{\\\"method\\\":\\\"cash\\\",\\\"amount\\\":\\\"5\\\"}]'::jsonb,null,'rh-sale-2')" >/dev/null 2>&1; then echo "FAIL: custom line accepted after rollback"; exit 1; fi
[ "$(q "select count(*) from pos_sale_items where is_custom")" = 2 ] || { echo "FAIL: rollback lost history"; exit 1; }
q "select pos_complete_sale('$CSH','$S','[{\\\"product_id\\\":\\\"$PRD\\\",\\\"quantity\\\":1}]'::jsonb,'[{\\\"method\\\":\\\"cash\\\",\\\"amount\\\":\\\"10\\\"}]'::jsonb,null,'rh-sale-3')" >/dev/null || { echo "FAIL: normal sale broken after rollback"; exit 1; }
echo "4. rolled back: custom lines refused, earlier custom sales kept, normal sales work"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: pos_custom_items rollback rehearsal"
