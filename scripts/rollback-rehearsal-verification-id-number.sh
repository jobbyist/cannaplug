#!/usr/bin/env bash
# Rehearses 20261105001000_verification_id_number: the migration applies on top of every earlier migration, the function
# is service-role only, stores a checked number once and never replaces it, re-applying changes nothing, the rollback
# removes only the function (stored numbers stay), and the migration applies again afterwards. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_verification_id_number"
M=20261105001000_verification_id_number
U=00000000-0000-0000-0000-0000000000b1
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
[ "$(q "select has_function_privilege('authenticated','public.verification_record_id_number(uuid,text,date,text)','EXECUTE')")" = f ] || { echo "FAIL: browsers can call it"; exit 1; }
[ "$(q "select has_function_privilege('service_role','public.verification_record_id_number(uuid,text,date,text)','EXECUTE')")" = t ] || { echo "FAIL: server cannot call it"; exit 1; }
echo "1. applied: service role only"
q "insert into auth.users (id, email) values ('$U','idn@test.local')" >/dev/null
q "select verification_record_id_number('$U','AB123456','1990-01-01','rehearsal-1')" >/dev/null
q "select verification_record_id_number('$U','ZZ999999','1990-01-01','rehearsal-2')" >/dev/null
[ "$(q "select id_number from member_signup_details where user_id='$U'")" = AB123456 ] || { echo "FAIL: number not stored once"; exit 1; }
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select id_number from member_signup_details where user_id='$U'")" = AB123456 ] || { echo "FAIL: re-apply changed the data"; exit 1; }
echo "2. stored once, never replaced; re-applying changes nothing"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='verification_record_id_number'")" = 0 ] || { echo "FAIL: function remains"; exit 1; }
[ "$(q "select id_number from member_signup_details where user_id='$U'")" = AB123456 ] || { echo "FAIL: rollback lost stored numbers"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='verification_submit'")" = 1 ] || { echo "FAIL: verification_submit was touched"; exit 1; }
echo "3. rolled back: function gone, stored numbers kept, verification_submit untouched"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
echo "PASS: verification_id_number rollback rehearsal"
