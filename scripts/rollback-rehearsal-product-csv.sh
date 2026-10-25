#!/usr/bin/env bash
# Rehearses 20261025001000_product_csv: apply all -> roll back -> function gone, browser roles never had it -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_product_csv"
M=20261025001000_product_csv
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select count(*) from pg_proc where proname='bulk_upsert_products'")" = 1 ] || { echo "FAIL: function missing"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.bulk_upsert_products(uuid,jsonb,text,text)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
[ "$(q "select has_function_privilege('anon','public.bulk_upsert_products(uuid,jsonb,text,text)','execute')")" = f ] || { echo "FAIL: anon can execute"; exit 1; }
echo "1. applied; bulk_upsert_products present, service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='bulk_upsert_products'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
echo "2. rolled back; function gone"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
