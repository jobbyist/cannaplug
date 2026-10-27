#!/usr/bin/env bash
# Rehearses 20261027007000_signup_details: apply all -> details stored -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_signup_details"
M=20261027007000_signup_details
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
q "insert into auth.users (id,email,raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000aa','rh@test.local', jsonb_build_object('full_name','Rae Hearsal','first_name','Rae','last_name','Hearsal','id_number','AB123456','referral_code','FRIEND1'))" >/dev/null
[ "$(q "select id_number||'/'||referral_code from public.member_signup_details where user_id='00000000-0000-0000-0000-0000000000aa'")" = "AB123456/FRIEND1" ] || { echo "FAIL: details not stored"; exit 1; }
[ "$(q "select (raw_user_meta_data ? 'id_number')::text from auth.users where id='00000000-0000-0000-0000-0000000000aa'")" = false ] || { echo "FAIL: ID number left in user metadata"; exit 1; }
echo "1. applied; details stored and removed from user metadata"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from information_schema.tables where table_name='member_signup_details'")" = 0 ] || { echo "FAIL: table still present"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
