#!/usr/bin/env bash
# Rehearses 20261027001000_sale_expiry: apply all -> an ended sale is reverted -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_sale_expiry"
M=20261027001000_sale_expiry
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
q "insert into public.products (slug,name,category,price_rand,regular_price_rand,sale_ends_at) values ('rh-sale','Rehearsal','Flower',80,100,now() - interval '1 minute')" >/dev/null
[ "$(q "select public.products_end_expired_sales(NULL)")" = 1 ] || { echo "FAIL: ended sale not reverted"; exit 1; }
[ "$(q "select price_rand::int || '/' || coalesce(regular_price_rand::text,'null') from public.products where slug='rh-sale'")" = "100/null" ] || { echo "FAIL: wrong price after sale"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.products_end_expired_sales(uuid)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
echo "1. applied; ended sales go back to the regular price, service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select to_regprocedure('public.products_end_expired_sales(uuid)') is null")" = t ] || { echo "FAIL: function still present"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
