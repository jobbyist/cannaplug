#!/usr/bin/env bash
# Rehearses 20261025004000_in_store_pickup: apply all -> roll back -> pickup gone, old functions back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_pickup"
M=20261025004000_in_store_pickup
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select is_pickup from public.delivery_options where code='collection'")" = t ] || { echo "FAIL: pickup option missing"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public._order_is_pickup(text)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.transition_order_status(uuid,text,uuid,text)','execute')")" = f ] || { echo "FAIL: transition grant widened"; exit 1; }
echo "1. applied; pickup option present, helpers service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from public.delivery_options where code='collection'")" = 0 ] || { echo "FAIL: pickup option remains"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='_order_is_pickup'")" = 0 ] || { echo "FAIL: helper remains"; exit 1; }
[ "$(q "select position('_order_is_pickup' in pg_get_functiondef('public.transition_order_status(uuid,text,uuid,text)'::regprocedure))")" = 0 ] || { echo "FAIL: old transition not restored"; exit 1; }
echo "2. rolled back; pickup gone, previous functions restored"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
