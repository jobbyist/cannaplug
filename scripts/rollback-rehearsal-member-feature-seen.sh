#!/usr/bin/env bash
# Rehearses 20261031002000_member_feature_seen: apply, a member marks the Ask The Plug intro as seen (stored once,
# audited once), the same key replays without a second row, a second sighting keeps the first action, another member
# is separate, browser roles cannot touch the table or the functions, re-apply changes nothing, roll back, re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_member_feature_seen"
M=20261031002000_member_feature_seen
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222
q "insert into auth.users (id, email) values ('$A','a@x.co'),('$B','b@x.co')" >/dev/null
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
MARK="select public.member_feature_mark_seen("
q "${MARK}'$A','ask_the_plug_intro','opened','key-0000001')" >/dev/null
q "${MARK}'$A','ask_the_plug_intro','opened','key-0000001')" >/dev/null
q "${MARK}'$A','ask_the_plug_intro','dismissed','key-0000002')" >/dev/null
[ "$(q "select count(*) from public.member_feature_seen")" = 1 ] || { echo "FAIL: one row per member and feature"; exit 1; }
[ "$(q "select action from public.member_feature_seen where user_id='$A'")" = opened ] || { echo "FAIL: first action kept"; exit 1; }
[ "$(q "select count(*) from public.audit_log where action='member_feature_seen'")" = 1 ] || { echo "FAIL: audited once"; exit 1; }
q "${MARK}'$B','ask_the_plug_preview','dismissed','key-0000003')" >/dev/null
[ "$(q "select array_to_string(public.member_features_seen('$A'),',')")" = ask_the_plug_intro ] || { echo "FAIL: A's list"; exit 1; }
[ "$(q "select array_to_string(public.member_features_seen('$B'),',')")" = ask_the_plug_preview ] || { echo "FAIL: B's list"; exit 1; }
if q "${MARK}'33333333-3333-3333-3333-333333333333','ask_the_plug_intro','opened','key-0000004')" >/dev/null 2>&1; then
  echo "FAIL: unknown member must be refused"; exit 1; fi
if q "${MARK}'$A','Ask The Plug!','opened','key-0000005')" >/dev/null 2>&1; then echo "FAIL: bad feature key"; exit 1; fi
for role in anon authenticated; do
  if q "set role $role; select * from public.member_feature_seen" >/dev/null 2>&1; then echo "FAIL: $role reads table"; exit 1; fi
  if q "set role $role; ${MARK}'$A','ask_the_plug_intro','opened','key-0000006')" >/dev/null 2>&1; then
    echo "FAIL: $role calls mark_seen"; exit 1; fi
  if q "set role $role; select public.member_features_seen('$A')" >/dev/null 2>&1; then echo "FAIL: $role reads list"; exit 1; fi
done
echo "1. applied: stored once, first action kept, audited once, per member, browser roles refused"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from public.member_feature_seen")" = 2 ] || { echo "FAIL: re-apply changed data"; exit 1; }
echo "2. re-applied: nothing changed"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('member_feature_mark_seen','member_features_seen')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from information_schema.tables where table_name='member_feature_seen'")" = 0 ] || { echo "FAIL: table remains"; exit 1; }
echo "3. rolled back"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
