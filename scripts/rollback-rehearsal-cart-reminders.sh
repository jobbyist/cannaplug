#!/usr/bin/env bash
# Rehearses 20261127007000_cart_reminders: applies on top of every earlier migration, saves a basket and queues one reminder,
# the functions are service-role only, re-applying changes nothing, the rollback removes the table, functions and the cart-bonus
# rule (and puts the email tiers back) while keeping orders and queued emails, and the migration applies again afterwards.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_cart"
M=20261127007000_cart_reminders
APPROVER=00000000-0000-0000-0000-0000000000f1
MEMBER=00000000-0000-0000-0000-0000000000f2
PRD=00000000-0000-0000-0000-0000000000f3
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
q "insert into products (id, slug, name, category, price_rand) values ('$PRD','rh-cart','Rehearsal','Flower',100)" >/dev/null
[ "$(q "select public._email_tier('cart_reminder')")" = 1 ] || { echo "FAIL: cart_reminder already tiered"; exit 1; }
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.cart_save(uuid,jsonb)','EXECUTE')")" = f ] || { echo "FAIL: browsers can save baskets"; exit 1; }
[ "$(q "select has_table_privilege('authenticated','public.member_carts','SELECT')")" = f ] || { echo "FAIL: browsers can read baskets"; exit 1; }
[ "$(q "select public._email_tier('cart_reminder')")" = 3 ] && [ "$(q "select public._email_tier('order_abandoned')")" = 2 ] || { echo "FAIL: tiers"; exit 1; }
echo "1. applied: service-role only, cart emails low priority, unpaid-order emails normal"
q "select cart_save('$MEMBER','[{\\\"product_id\\\":\\\"$PRD\\\",\\\"quantity\\\":2}]'::jsonb)" >/dev/null
q "update member_carts set updated_at = now() - interval '3 hours' where user_id='$MEMBER'" >/dev/null
[ "$(q "select public.cart_reminders_enqueue('2026-11-10T10:00:00Z')")" = 1 ] || { echo "FAIL: no reminder queued"; exit 1; }
[ "$(q "select public.cart_reminders_enqueue('2026-11-10T10:00:00Z')")" = 0 ] || { echo "FAIL: reminder queued twice"; exit 1; }
echo "2. one reminder queued for the idle basket, none on the second run"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from notification_events where template='cart_reminder'")" = 1 ] && [ "$(q "select count(*) from member_carts")" = 1 ] || { echo "FAIL: re-apply changed data"; exit 1; }
echo "3. re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('cart_save','cart_get','cart_unsubscribe','cart_reminders_enqueue','_cart_bonus_applies')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select to_regclass('public.member_carts') is null")" = t ] || { echo "FAIL: table remains"; exit 1; }
[ "$(q "select position('cart_bonus' in pg_get_functiondef('public.accrue_order_loyalty(uuid)'::regprocedure))")" = 0 ] || { echo "FAIL: cart bonus rule remains"; exit 1; }
[ "$(q "select public._email_tier('cart_reminder')")" = 1 ] || { echo "FAIL: tiers not restored"; exit 1; }
[ "$(q "select count(*) from notification_events where template='cart_reminder'")" = 1 ] || { echo "FAIL: queued email lost"; exit 1; }
echo "4. rolled back: table, functions and bonus rule gone, tiers restored, queued email kept"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: cart_reminders rollback rehearsal"
