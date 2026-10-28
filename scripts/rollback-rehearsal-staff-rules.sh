#!/usr/bin/env bash
# Rehearses 20261028009000_staff_attach_rules: apply all -> staff skip the ID check and the attach rule exists ->
# roll back (the ID check applies to staff again, the rule is gone) -> re-apply. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_staffrules"
M=20261028009000_staff_attach_rules
U=00000000-0000-0000-0000-0000000000b1
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
q "insert into auth.users(id,email) values ('$U','s@t.l')" >/dev/null
q "insert into public.user_roles(user_id, role) values ('$U','budtender')" >/dev/null
# applied: a staff member with no ID passes the gate; the attach rule exists and a budtender cannot attach themselves
[ "$(q "select count(*) from pg_proc where proname='_pos_can_attach_staff'")" = 1 ] || { echo "FAIL: rule missing"; exit 1; }
q "select public._require_verified_member('$U')" >/dev/null || { echo "FAIL: staff should skip the ID check"; exit 1; }
[ "$(q "select public._pos_can_attach_staff('$U','$U')")" = f ] || { echo "FAIL: budtender attached themselves"; exit 1; }
echo "1. applied; staff skip the ID check, a budtender cannot attach themselves"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname='_pos_can_attach_staff'")" = 0 ] || { echo "FAIL: rule remains"; exit 1; }
if run "$P -d $DB -c \"select public._require_verified_member('$U')\"" >/dev/null 2>&1; then echo "FAIL: staff should need an ID again"; exit 1; fi
echo "2. rolled back; staff need a verified ID again, the rule is gone"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
q "select public._require_verified_member('$U')" >/dev/null || { echo "FAIL: after re-apply"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
