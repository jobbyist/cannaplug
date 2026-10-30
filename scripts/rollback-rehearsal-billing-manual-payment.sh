#!/usr/bin/env bash
# Rehearses 20261031003000_billing_manual_payment: apply, an admin records a manual payment (stored once, COMPLETE,
# provider manual), a manager is refused, Payfast/PayPal rows still work, re-apply changes nothing, the rollback is
# refused while manual payments exist, then works once they are removed, and the migration re-applies.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_billing_manual_payment"
M=20261031003000_billing_manual_payment
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222
q "insert into auth.users (id, email) values ('$A','admin@x.co'),('$B','mgr@x.co')" >/dev/null
q "insert into public.user_roles (user_id, role) values ('$A','admin'),('$B','manager') on conflict do nothing" >/dev/null
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
TODAY="(now() at time zone 'Africa/Johannesburg')::date"
REC="select public.billing_record_manual_payment("
q "${REC}'$A','shopify-admin-api',2875,'USD',$TODAY,'Paid by card with Shopify','key-0000001')" >/dev/null
q "${REC}'$A','shopify-admin-api',2875,'USD',$TODAY,'Paid by card with Shopify','key-0000001')" >/dev/null
[ "$(q "select count(*) from public.billing_payments where provider='manual' and status='COMPLETE'")" = 1 ] || { echo "FAIL: stored once"; exit 1; }
if q "${REC}'$B','shopify-admin-api',100,'USD',$TODAY,'manager attempt','key-0000002')" >/dev/null 2>&1; then echo "FAIL: manager allowed"; exit 1; fi
q "select public.billing_record_payment('shopify-admin-api','paypal','PAY-1','COMPLETED',2875,'USD','sub')" >/dev/null
echo "1. applied: admin records once, manager refused, provider payments unchanged"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from public.billing_payments")" = 2 ] || { echo "FAIL: re-apply changed data"; exit 1; }
echo "2. re-applied: nothing changed"
if apply "$ROOT/supabase/rollbacks/${M}_rollback.sql"; then echo "FAIL: rollback must be refused while manual payments exist"; exit 1; fi
echo "3. rollback refused while manual payments exist"
q "delete from public.billing_payments where provider='manual'" >/dev/null
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='billing_record_manual_payment'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
if q "insert into public.billing_payments (account_id, provider, provider_payment_id, status) select id,'manual','x','COMPLETE' from public.billing_accounts limit 1" >/dev/null 2>&1; then
  echo "FAIL: manual provider still allowed"; exit 1; fi
echo "4. rolled back after removing them"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
