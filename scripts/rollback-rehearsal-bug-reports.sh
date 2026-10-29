#!/usr/bin/env bash
# Rehearses 20261029009000_bug_reports: apply, submit a report (stored, one staff email per recipient), a repeated key
# sends nothing new, the 6th report from one address in an hour is refused, then roll back (refused while reports
# exist; works once the table is cleared) and apply again. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_bug_reports"
M=20261029009000_bug_reports
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
SUB="select public.bug_report_submit('Thandi','t@x.co','bug','The cart button does nothing','/shop','Mozilla/5.0','iphash1',array['a@x.co','b@x.co'],'KEY'||"
q "${SUB}'00000001')" >/dev/null
[ "$(q "select count(*) from public.bug_reports")" = 1 ] || { echo "FAIL: stored"; exit 1; }
[ "$(q "select count(*) from public.notification_events where template='bug_report_staff' and recipient in ('a@x.co','b@x.co')")" = 2 ] || { echo "FAIL: emails"; exit 1; }
q "${SUB}'00000001')" >/dev/null
[ "$(q "select count(*) from public.bug_reports")" = 1 ] || { echo "FAIL: replay stored twice"; exit 1; }
for i in 2 3 4 5; do q "${SUB}'0000000$i')" >/dev/null; done
if q "${SUB}'00000006')" >/dev/null 2>&1; then echo "FAIL: 6th report must be refused"; exit 1; fi
echo "1. applied: stored, one email per recipient, replay sends nothing new, rate limit holds"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from public.bug_reports")" = 5 ] || { echo "FAIL: re-apply changed data"; exit 1; }
echo "2. re-applied: nothing changed"
if apply "$ROOT/supabase/rollbacks/${M}_rollback.sql"; then echo "FAIL: rollback must be refused while reports exist"; exit 1; fi
echo "3. rollback refused while reports exist"
q "truncate public.bug_reports" >/dev/null
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='bug_report_submit'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
[ "$(q "select count(*) from information_schema.tables where table_name='bug_reports'")" = 0 ] || { echo "FAIL: table remains"; exit 1; }
echo "4. rolled back after clearing"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
