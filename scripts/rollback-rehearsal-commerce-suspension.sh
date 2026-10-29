#!/usr/bin/env bash
# Rehearses 20261031001000_commerce_suspension: apply (the suspension starts, tied to the Shopify bill), a completed
# payment on another account leaves it, a completed Shopify payment lifts it, re-apply changes nothing, roll back,
# apply again. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_commerce_suspension"
M=20261031001000_commerce_suspension
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
[ "$(q "select public.commerce_suspension_status()->>'suspended'")" = true ] || { echo "FAIL: migration must start the suspension"; exit 1; }
[ "$(q "select public.commerce_suspension_status()->>'billing_slug'")" = shopify-admin-api ] || { echo "FAIL: tied to the Shopify bill"; exit 1; }
echo "1. applied: suspension active, tied to shopify-admin-api"
q "select public.billing_record_payment('payfast-gateway','payfast','p-other','COMPLETE',18000,'ZAR','x')" >/dev/null
[ "$(q "select public.commerce_suspension_status()->>'suspended'")" = true ] || { echo "FAIL: another account's payment must not lift it"; exit 1; }
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from public.commerce_suspensions")" = 1 ] || { echo "FAIL: re-apply added a row"; exit 1; }
echo "2. other payment ignored; re-applied: nothing changed"
q "select public.billing_record_payment('shopify-admin-api','paypal','p-shopify','COMPLETED',2875,'USD','x')" >/dev/null
[ "$(q "select public.commerce_suspension_status()->>'suspended'")" = false ] || { echo "FAIL: the Shopify payment must lift it"; exit 1; }
[ "$(q "select resumed_via from public.commerce_suspensions")" = payment ] || { echo "FAIL: resumed_via"; exit 1; }
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after resume"; exit 1; }
[ "$(q "select public.commerce_suspension_status()->>'suspended'")" = false ] || { echo "FAIL: re-running after the payment must not suspend again"; exit 1; }
echo "3. Shopify payment lifted the suspension automatically"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname like 'commerce_%'")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from information_schema.tables where table_name='commerce_suspensions'")" = 0 ] || { echo "FAIL: table remains"; exit 1; }
echo "4. rolled back"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
