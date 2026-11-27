#!/usr/bin/env bash
# Rehearses 20261127002000_account_deactivation_deletion: apply, a member deactivates (and cannot be written to from a browser
# role), re-apply changes nothing, rollback is refused while an account is deactivated, works once it is reactivated and leaves
# the Customers list and order gate as they were, then apply again. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_account_lifecycle"
M=20261127002000_account_deactivation_deletion
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
U=aaaaaaaa-0000-4000-8000-000000000001
q "insert into auth.users (id, email) values ('$U', 'member@test.local')" >/dev/null
q "insert into public.user_roles (user_id, role) values ('$U', 'customer') on conflict do nothing" >/dev/null
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select public.member_account_set_status('$U','deactivate','rehearsal-key-1')->>'status'")" = deactivated ] || { echo "FAIL: deactivate"; exit 1; }
if q "set role authenticated; update public.profiles set deactivated_at = null where id = '$U'" >/dev/null 2>&1; then echo "FAIL: browser role must not write deactivated_at"; exit 1; fi
echo "1. applied: member deactivated, browser role cannot clear it"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select public.member_account_state('$U')->>'status'")" = deactivated ] || { echo "FAIL: re-apply changed data"; exit 1; }
echo "2. re-applied: nothing changed"
if apply "$ROOT/supabase/rollbacks/${M}_rollback.sql"; then echo "FAIL: rollback must be refused while an account is deactivated"; exit 1; fi
echo "3. rollback refused while an account is deactivated"
q "select public.member_account_set_status('$U','reactivate','rehearsal-key-2')" >/dev/null
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('admin_account_delete','member_account_set_status','member_account_state','_member_open_orders')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='profiles' and column_name in ('deactivated_at','deletion_requested_at','deleted_at')")" = 0 ] || { echo "FAIL: columns remain"; exit 1; }
q "select public.admin_customers_page('$U', null, 5, 0)" >/dev/null 2>&1 && { echo "FAIL: non-staff must be refused by the restored list"; exit 1; }
echo "4. rolled back after reactivating"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
