#!/usr/bin/env bash
# Rehearses 20261029007000_username_autogen:
#   old data: apply everything before it; a verified member, a second verified member with the same name, a staff
#   member and an unverified member, none with a username
#   -> apply: the verified members and staff get generated usernames (the same-name one gets digits), the unverified
#      member gets none; the generated name can be changed once, then it is final
#   -> re-apply: nobody's username changes
#   -> roll back: generated names that were never confirmed are cleared, a name the member changed is kept, the
#      column is gone and the previous functions are back; the migration applies again afterwards.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_usernames"
M=20261029007000_username_autogen
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
A=00000000-0000-0000-0000-0000000000a0
U1=00000000-0000-0000-0000-0000000000a1
U2=00000000-0000-0000-0000-0000000000a2
U3=00000000-0000-0000-0000-0000000000a3
U4=00000000-0000-0000-0000-0000000000a4
for u in $A $U1 $U2 $U3 $U4; do q "insert into auth.users(id,email) values ('$u','$u@t.l')" >/dev/null; done
q "insert into public.user_roles(user_id,role) values ('$A','manager'),('$U2','budtender'),('$U1','customer'),('$U3','customer'),('$U4','customer') on conflict do nothing" >/dev/null
q "insert into public.profiles(id,first_name,last_name,full_name) values ('$U1','Thandi','Nkosi','Thandi Nkosi'),('$U4','Thandi','Nkosi','Thandi Nkosi'),('$U2',null,null,'Sipho Dlamini'),('$U3','Zola','Mbeki','Zola Mbeki') on conflict (id) do update set first_name=excluded.first_name,last_name=excluded.last_name,full_name=excluded.full_name" >/dev/null
for u in $U1 $U4; do q "insert into public.customer_verification(user_id,status,method,verified_at,verified_by,reviewed_at,reviewed_by) values ('$u','verified','manual_id_review',now(),'$A',now(),'$A')" >/dev/null; done
echo "0. data in place, no usernames"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
n() { q "select coalesce(username,'-')||'/'||username_auto from public.profiles where id='$1'"; }
[ "$(n $U1)" = "thandin/true" ] || { echo "FAIL: U1 got $(n $U1)"; exit 1; }
case "$(n $U4)" in thandin[0-9][0-9]/true) ;; *) echo "FAIL: U4 got $(n $U4)"; exit 1;; esac
[ "$(n $U2)" = "sipho/true" ] || { echo "FAIL: staff got $(n $U2)"; exit 1; }
[ "$(n $U3)" = "-/false" ] || { echo "FAIL: unverified got $(n $U3)"; exit 1; }
echo "1. applied: verified members and staff generated, unverified left empty, duplicate name got digits"
R1=$(n $U1); R4=$(n $U4)
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(n $U1)" = "$R1" ] && [ "$(n $U4)" = "$R4" ] || { echo "FAIL: usernames changed on re-apply"; exit 1; }
echo "2. re-applied: no username changed"
q "select public.member_set_username('$U1','thandi_n','rehearsal-1')" >/dev/null
[ "$(n $U1)" = "thandi_n/false" ] || { echo "FAIL: change once"; exit 1; }
if q "select public.member_set_username('$U1','thandi_x','rehearsal-2')" >/dev/null 2>&1; then echo "FAIL: second change must be refused"; exit 1; fi
echo "3. changed once, second change refused"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='profiles' and column_name='username_auto'")" = 0 ] || { echo "FAIL: column remains"; exit 1; }
[ "$(q "select coalesce(username,'-') from public.profiles where id='$U1'")" = "thandi_n" ] || { echo "FAIL: chosen name lost"; exit 1; }
[ "$(q "select coalesce(username,'-') from public.profiles where id='$U4'")" = "-" ] || { echo "FAIL: generated name kept"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('member_ensure_username','_username_assign','_username_generate')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
echo "4. rolled back: unconfirmed generated names cleared, chosen name kept, column and helpers gone"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
