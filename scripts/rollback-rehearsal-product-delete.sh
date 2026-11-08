#!/usr/bin/env bash
# Rehearses 20261108001000_product_delete: the migration applies on top of every earlier migration, the functions are
# service-role only, a product with no history is removed (with its price history) while a sold / stocked one is
# archived, price history still refuses an ordinary DELETE, re-applying changes nothing, the rollback restores the
# old guard and drops the columns, and the migration applies again afterwards. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_product_delete"
M=20261108001000_product_delete
MGR=00000000-0000-0000-0000-0000000000d1
NEW=00000000-0000-0000-0000-0000000000d2
OLD=00000000-0000-0000-0000-0000000000d3
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
q "insert into auth.users (id, email) values ('$MGR','mgr@test.local')" >/dev/null
q "insert into user_roles (user_id, role) values ('$MGR','manager')" >/dev/null
q "insert into products (id, slug, name, category, price_rand) values ('$NEW','rh-new','Typo product','Flower',10), ('$OLD','rh-old','Sold product','Flower',10)" >/dev/null
q "select receive_stock('$MGR','$OLD','B1',5,null,null,null,'rh-receive-1')" >/dev/null
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.product_delete(uuid,uuid,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can delete"; exit 1; }
[ "$(q "select has_function_privilege('anon','public.product_restore(uuid,uuid,text)','EXECUTE')")" = f ] || { echo "FAIL: anon can restore"; exit 1; }
echo "1. applied: functions are service-role only"
[ "$(q "select product_delete('$MGR','$NEW','rh-del-1')->>'mode'")" = deleted ] || { echo "FAIL: new product not deleted"; exit 1; }
[ "$(q "select count(*) from products where id='$NEW'")" = 0 ] || { echo "FAIL: product row remains"; exit 1; }
[ "$(q "select count(*) from product_price_history where product_id='$NEW'")" = 0 ] || { echo "FAIL: price history remains"; exit 1; }
[ "$(q "select product_delete('$MGR','$OLD','rh-del-2')->>'mode'")" = archived ] || { echo "FAIL: stocked product not archived"; exit 1; }
[ "$(q "select is_active::text || (archived_at is not null)::text from products where id='$OLD'")" = falsetrue ] || { echo "FAIL: archive state"; exit 1; }
if run "$P -d $DB -v ON_ERROR_STOP=1 -c \"delete from product_price_history where product_id='$OLD'\"" >/dev/null 2>&1; then echo "FAIL: price history deletable"; exit 1; fi
echo "2. an unused product is removed; a stocked one is archived; price history is still guarded"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select (archived_at is not null)::text from products where id='$OLD'")" = true ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "3. re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('product_delete','product_restore','_product_has_history','_products_archive_consistency')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='products' and column_name in ('archived_at','archived_by')")" = 0 ] || { echo "FAIL: columns remain"; exit 1; }
[ "$(q "select is_active::text from products where id='$OLD'")" = false ] || { echo "FAIL: archived product came back on"; exit 1; }
if run "$P -d $DB -v ON_ERROR_STOP=1 -c \"select set_config('cannaplug.deleting_product','$OLD',false); delete from product_price_history where product_id='$OLD'\"" >/dev/null 2>&1; then echo "FAIL: old guard not restored"; exit 1; fi
echo "4. rolled back: functions and columns gone; archived product stays off; the original guard is back"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: product_delete rollback rehearsal"
