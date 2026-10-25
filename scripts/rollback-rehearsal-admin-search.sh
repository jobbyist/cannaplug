#!/usr/bin/env bash
# Rehearses 20261025005000_admin_search: apply all -> roll back -> function and indexes gone -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_admin_search"
M=20261025005000_admin_search
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select count(*) from pg_proc where proname='admin_search'")" = 1 ] || { echo "FAIL: function missing"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.admin_search(uuid,text,integer)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
[ "$(q "select count(*) from pg_indexes where indexname like '%_trgm'")" = 8 ] || { echo "FAIL: trigram indexes missing"; exit 1; }
echo "1. applied; admin_search service-role only, 8 trigram indexes"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='admin_search'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
[ "$(q "select count(*) from pg_indexes where indexname like '%_trgm'")" = 0 ] || { echo "FAIL: indexes remain"; exit 1; }
echo "2. rolled back; function and indexes gone"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
