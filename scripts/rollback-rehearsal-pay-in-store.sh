#!/usr/bin/env bash
# Rehearses 20261127004000_pay_in_store: the migration applies on top of every earlier migration, pay in store reserves a
# collection order for 24 hours and staff can take the payment, the new function is service-role only, re-applying changes
# nothing, the rollback restores the online-only rules (no 'cash' at checkout, 2-hour hold cap) while keeping orders already
# placed, and the migration applies again afterwards. Needs PostgreSQL 16 binaries (scripts/test-db.sh uses the same ones).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_pay_in_store"
M=20261127004000_pay_in_store
STAFF=00000000-0000-0000-0000-0000000000d1
MEMBER=00000000-0000-0000-0000-0000000000d2
APPROVER=00000000-0000-0000-0000-0000000000d3
PRD=00000000-0000-0000-0000-0000000000d4
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
q "insert into auth.users (id, email) values ('$STAFF','s@test.local'),('$MEMBER','m@test.local'),('$APPROVER','a@test.local')" >/dev/null
q "insert into user_roles (user_id, role) values ('$STAFF','budtender'),('$APPROVER','manager')" >/dev/null
q "insert into customer_verification (user_id, status, method, verified_at, verified_by, reviewed_at, reviewed_by) values ('$MEMBER','verified','manual_id_review',now(),'$APPROVER',now(),'$APPROVER')" >/dev/null
q "insert into products (id, slug, name, category, price_rand) values ('$PRD','rh-pis','Rehearsal','Flower',100)" >/dev/null
q "select receive_stock('$APPROVER','$PRD','B1',10,null,null,null,'rh-receive-1')" >/dev/null
ITEMS="[{\\\"product_id\\\":\\\"$PRD\\\",\\\"quantity\\\":2}]"
# before the migration: cash is refused at checkout
if q "select checkout_place_order('$MEMBER','$ITEMS'::jsonb,'Rehearsal','+27 82 000 0000','collection',null,'cash',200,null,'rh-before')" >/dev/null 2>&1; then echo "FAIL: cash accepted before the migration"; exit 1; fi
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.order_take_in_store_payment(uuid,uuid,text,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can take payments"; exit 1; }
[ "$(q "select has_function_privilege('service_role','public.order_take_in_store_payment(uuid,uuid,text,text)','EXECUTE')")" = t ] || { echo "FAIL: server cannot take payments"; exit 1; }
echo "1. applied: the in-store payment function is service-role only"
O1="$(q "select checkout_place_order('$MEMBER','$ITEMS'::jsonb,'Rehearsal','+27 82 000 0000','collection',null,'cash',200,null,'rh-order-1')->>'order_id'")"
[ "$(q "select payment_method||'/'||status from orders where id='$O1'")" = "cash/awaiting_payment" ] || { echo "FAIL: order not reserved as pay in store"; exit 1; }
H="$(q "select round(extract(epoch from (min(expires_at) - now())) / 3600) from stock_reservations where order_id='$O1' and status='held'")"
[ "$H" = 24 ] || { echo "FAIL: hold is $H hours, expected 24"; exit 1; }
q "select order_take_in_store_payment('$STAFF','$O1','card','rh-pay-0001')" >/dev/null
[ "$(q "select status from orders where id='$O1'")" = confirmed ] || { echo "FAIL: payment did not confirm the order"; exit 1; }
O2="$(q "select checkout_place_order('$MEMBER','$ITEMS'::jsonb,'Rehearsal','+27 82 000 0000','collection',null,'cash',200,null,'rh-order-2')->>'order_id'")"
echo "2. a pay-in-store order is held 24 hours, staff take the payment and it confirms; a second order stays awaiting payment"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select status from orders where id='$O2'")" = awaiting_payment ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "3. re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='order_take_in_store_payment'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
if q "select checkout_place_order('$MEMBER','$ITEMS'::jsonb,'Rehearsal','+27 82 000 0000','collection',null,'cash',200,null,'rh-after')" >/dev/null 2>&1; then echo "FAIL: cash accepted after rollback"; exit 1; fi
[ "$(q "select position('120)' in pg_get_functiondef('public.create_online_order(uuid,jsonb,text,text,text,text,integer)'::regprocedure)) > 0")" = t ] || { echo "FAIL: hold cap not restored"; exit 1; }
[ "$(q "select status from orders where id='$O1'")" = confirmed ] && [ "$(q "select status from orders where id='$O2'")" = awaiting_payment ] || { echo "FAIL: rollback changed existing orders"; exit 1; }
echo "4. rolled back: no cash at checkout, 2-hour hold cap restored, orders already placed untouched"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: pay_in_store rollback rehearsal"
