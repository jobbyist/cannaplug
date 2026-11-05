#!/usr/bin/env bash
# Rehearses 20261105002000_password_reset_emails: the migration applies on top of every earlier migration, the table has
# RLS and no browser access, the functions are service-role only, a reset is limited to 3 an hour per address and counts
# against the email budget, re-applying changes nothing, the rollback restores the original budget count and removes
# the rest, and the migration applies again afterwards. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_password_reset_emails"
M=20261105002000_password_reset_emails
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
BEFORE="$(q "select md5(prosrc) from pg_proc where proname='_emails_sent_24h'")"
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select count(*) from pg_class where relname='password_reset_requests' and relrowsecurity")" = 1 ] || { echo "FAIL: table missing or RLS off"; exit 1; }
[ "$(q "select count(*) from information_schema.role_table_grants where table_name='password_reset_requests' and grantee in ('anon','authenticated')")" = 0 ] || { echo "FAIL: browser grants"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.password_reset_begin(text,text,uuid,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can call it"; exit 1; }
echo "1. applied: table with RLS and no browser grants, service-role functions"
for i in 1 2 3 4; do q "select password_reset_begin('a@b.co','iphash01',null,'rehearsal-key-$i')" >/dev/null; done
[ "$(q "select count(*) from password_reset_requests")" = 3 ] || { echo "FAIL: per-address limit"; exit 1; }
[ "$(q "select _emails_sent_24h()")" = 3 ] || { echo "FAIL: resets not counted in the budget"; exit 1; }
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from password_reset_requests")" = 3 ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "2. 3 an hour per address, counted in the budget; re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_class where relname='password_reset_requests'")" = 0 ] || { echo "FAIL: table remains"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname like 'password_reset_%' or proname='_password_reset_email_hash'")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select md5(prosrc) from pg_proc where proname='_emails_sent_24h'")" = "$BEFORE" ] || { echo "FAIL: budget count not restored"; exit 1; }
echo "3. rolled back: table and functions gone, budget count restored exactly"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: password_reset_emails rollback rehearsal"
