#!/usr/bin/env bash
# Rehearses 20261127006000_abandoned_order_reminders: applies on top of every earlier migration, queues one reminder for an
# unpaid online order, the function is service-role only, re-applying changes nothing, the rollback removes the function and the
# member lock while keeping orders and queued emails, and the migration applies again afterwards. Needs PostgreSQL 16 binaries.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_abandoned"
M=20261127006000_abandoned_order_reminders
APPROVER=00000000-0000-0000-0000-0000000000e1
MEMBER=00000000-0000-0000-0000-0000000000e2
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
q "insert into auth.users (id, email) values ('$APPROVER','a@test.local'),('$MEMBER','m@test.local')" >/dev/null
q "insert into user_roles (user_id, role) values ('$APPROVER','manager')" >/dev/null
q "insert into customer_verification (user_id, status, method, verified_at, verified_by, reviewed_at, reviewed_by) values ('$MEMBER','verified','manual_id_review',now(),'$APPROVER',now(),'$APPROVER')" >/dev/null
q "insert into products (id, slug, name, category, price_rand) values ('$PRD','rh-ab','Rehearsal','Flower',100)" >/dev/null
q "select receive_stock('$APPROVER','$PRD','B1',10,null,null,null,'rh-receive-1')" >/dev/null
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.abandoned_order_reminders_enqueue()','EXECUTE')")" = f ] || { echo "FAIL: browsers can run the reminders"; exit 1; }
echo "1. applied: reminder function is service-role only"
ITEMS="[{\\\"product_id\\\":\\\"$PRD\\\",\\\"quantity\\\":1}]"
O1="$(q "select checkout_place_order('$MEMBER','$ITEMS'::jsonb,'Rehearsal','+27 82 000 0000','collection',null,'card',100,null,'rh-order-1')->>'order_id'")"
q "update orders set created_at = now() - interval '40 minutes' where id='$O1'" >/dev/null
[ "$(q "select public.abandoned_order_reminders_enqueue()")" = 1 ] || { echo "FAIL: no reminder queued"; exit 1; }
[ "$(q "select public.abandoned_order_reminders_enqueue()")" = 0 ] || { echo "FAIL: reminder queued twice"; exit 1; }
echo "2. one reminder queued for the unpaid order, none on the second run"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from notification_events where template='order_abandoned'")" = 1 ] || { echo "FAIL: re-apply changed the queue"; exit 1; }
echo "3. re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='abandoned_order_reminders_enqueue'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
[ "$(q "select position('-- pis_lock' in pg_get_functiondef('public.checkout_place_order(uuid,jsonb,text,text,text,uuid,text,numeric,text,text)'::regprocedure))")" = 0 ] || { echo "FAIL: lock remains"; exit 1; }
[ "$(q "select status from orders where id='$O1'")" = awaiting_payment ] && [ "$(q "select count(*) from notification_events where template='order_abandoned'")" = 1 ] || { echo "FAIL: rollback changed existing data"; exit 1; }
echo "4. rolled back: function and lock gone, order and queued email untouched"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: abandoned_reminders rollback rehearsal"
