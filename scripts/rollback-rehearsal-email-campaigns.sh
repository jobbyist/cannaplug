#!/usr/bin/env bash
# Rehearses 20261025006000_email_campaigns: apply all -> roll back -> table and functions gone -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_email_campaigns"
M=20261025006000_email_campaigns
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select relrowsecurity from pg_class where oid='public.email_campaigns'::regclass")" = t ] || { echo "FAIL: RLS off"; exit 1; }
[ "$(q "select has_table_privilege('authenticated','public.email_campaigns','select')")" = f ] || { echo "FAIL: browser can read campaigns"; exit 1; }
for fn in "email_campaign_send(uuid,uuid,text)" "member_newsletter_set(uuid,boolean,text)"; do
  [ "$(q "select has_function_privilege('authenticated','public.$fn','execute')")" = f ] || { echo "FAIL: authenticated can execute $fn"; exit 1; }
done
echo "1. applied; RLS on, no browser access, functions service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname like 'email_campaign_%' or proname like 'member_newsletter_%'")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select to_regclass('public.email_campaigns') is null")" = t ] || { echo "FAIL: table remains"; exit 1; }
echo "2. rolled back; table and functions gone"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
