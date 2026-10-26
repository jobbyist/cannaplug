#!/usr/bin/env bash
# Rehearses 20261026001000_budtender_id_review: apply all -> roll back (managers only again) -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_budtender_id"
M=20261026001000_budtender_id_review
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
def() { q "select position('$1' in pg_get_functiondef('public.verification_review(uuid,uuid,text,text,text,text)'::regprocedure)) > 0"; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(def "another staff member")" = t ] || { echo "FAIL: review not opened to budtenders"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.verification_review(uuid,uuid,text,text,text,text)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
echo "1. applied; budtenders may review, still service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(def "another manager")" = t ] || { echo "FAIL: manager rule not restored"; exit 1; }
echo "2. rolled back; managers only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
