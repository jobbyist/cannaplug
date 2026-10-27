#!/usr/bin/env bash
# Rehearses 20261027005000_online_only_sales: apply all -> flag stored and self-clearing -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_online_only"
M=20261027005000_online_only_sales
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
q "insert into public.products (slug,name,category,price_rand,regular_price_rand,sale_online_only) values ('rh-online','Rehearsal','Flower',80,100,true)" >/dev/null
[ "$(q "select sale_online_only from public.products where slug='rh-online'")" = t ] || { echo "FAIL: flag not stored"; exit 1; }
q "update public.products set price_rand = 100, regular_price_rand = NULL where slug='rh-online'" >/dev/null
[ "$(q "select sale_online_only from public.products where slug='rh-online'")" = f ] || { echo "FAIL: flag not cleared when the sale ends"; exit 1; }
echo "1. applied; the online-only flag clears itself when there is no sale"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='products' and column_name='sale_online_only'")" = 0 ] || { echo "FAIL: column still present"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
