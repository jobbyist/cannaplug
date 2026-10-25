#!/usr/bin/env bash
# Rehearses 20261025002000_launch_rules: apply all -> roll back -> function gone, browser roles never had it -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_launch_rules"
M=20261025002000_launch_rules
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select count(*) from pg_proc where proname='purchase_limit_set'")" = 1 ] || { echo "FAIL: function missing"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.purchase_limit_set(uuid,text,integer,boolean,text)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
[ "$(q "select has_function_privilege('anon','public.purchase_limit_set(uuid,text,integer,boolean,text)','execute')")" = f ] || { echo "FAIL: anon can execute"; exit 1; }
echo "1. applied; purchase_limit_set present, service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='purchase_limit_set'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='products' and column_name='low_stock_threshold'")" = 0 ] || { echo "FAIL: column remains"; exit 1; }
[ "$(q "select count(*) from pg_trigger where tgname in ('order_items_purchase_limit','pos_sale_items_purchase_limit')")" = 0 ] || { echo "FAIL: triggers remain"; exit 1; }
[ "$(q "select position('<= 5' in prosrc) > 0 from pg_proc where proname='email_automations_run'")" = t ] || { echo "FAIL: digest not restored"; exit 1; }
echo "2. rolled back; limits, reset and threshold gone, digest restored"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
