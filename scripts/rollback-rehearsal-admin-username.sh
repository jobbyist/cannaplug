#!/usr/bin/env bash
# Rehearses 20261029008000_admin_username: apply, a manager changes a member's username (audited), the Customers page
# returns and searches by username, then roll back (the tool and the username column of the page go; the changed
# username stays) and apply again. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_admin_username"
M=20261029008000_admin_username
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
MGR=00000000-0000-0000-0000-0000000000b1
MEM=00000000-0000-0000-0000-0000000000b2
for u in $MGR $MEM; do q "insert into auth.users(id,email) values ('$u','$u@t.l')" >/dev/null; done
q "insert into public.user_roles(user_id,role) values ('$MGR','manager'),('$MEM','customer') on conflict do nothing" >/dev/null
q "insert into public.profiles(id,full_name,username) values ('$MEM','Old Name','oldname') on conflict (id) do update set username='oldname', full_name='Old Name'" >/dev/null
echo "0. data in place"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
q "select public.admin_set_username('$MGR','$MEM','newname','Member asked for a new name','rehearsal-1')" >/dev/null
[ "$(q "select username||'/'||username_auto from public.profiles where id='$MEM'")" = "newname/false" ] || { echo "FAIL: change"; exit 1; }
[ "$(q "select count(*) from public.audit_log where action='admin_username_changed' and entity_id='$MEM'")" = 1 ] || { echo "FAIL: audit"; exit 1; }
[ "$(q "select (public.admin_customers_page('$MGR','newname',25,0)->'rows'->0->>'username')")" = "newname" ] || { echo "FAIL: page search"; exit 1; }
echo "1. applied: manager changed the username (audited); the page returns and searches by username"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select username from public.profiles where id='$MEM'")" = "newname" ] || { echo "FAIL: re-apply changed data"; exit 1; }
echo "2. re-applied: nothing changed"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='admin_set_username'")" = 0 ] || { echo "FAIL: tool remains"; exit 1; }
[ "$(q "select coalesce(public.admin_customers_page('$MGR',null,25,0)->'rows'->0->>'username','none')")" = "none" ] || { echo "FAIL: page still returns username"; exit 1; }
[ "$(q "select username from public.profiles where id='$MEM'")" = "newname" ] || { echo "FAIL: username lost"; exit 1; }
echo "3. rolled back: tool gone, page restored, changed username kept"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
