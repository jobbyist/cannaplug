#!/usr/bin/env bash
# Rehearses the rewards and referral migrations (20261029003000 + 20261029004000):
#   old data: apply everything before them, give members points at the OLD rate (R10 per point)
#   -> apply both: balances and lifetime points are converted (divided by 5, rounded down), tiers rescaled
#   -> re-apply: nothing is converted twice
#   -> roll back (refused while a conversion exists), then the old rate is back after the ledger is cleared.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_rewards"
A=20261029003000_loyalty_sources
B=20261029004000_rewards_referrals
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v a="$A" '{ n=$0; sub(/.*\//, "", n); if (n < a ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
U1=00000000-0000-0000-0000-0000000000c1
U2=00000000-0000-0000-0000-0000000000c2
U3=00000000-0000-0000-0000-0000000000c3
for u in $U1 $U2 $U3; do q "insert into auth.users(id,email) values ('$u','$u@t.l')" >/dev/null; done
# old rate: 1 point per R10. Insert earn rows straight into the ledger (the trigger keeps balance and tier).
# U1: 1000 points (R10,000), U2: 7 points, U3: 650 points then 200 spent = balance 450 (lifetime 650).
q "insert into public.orders (id,user_id,contact_name,contact_phone,total_rand) select ('00000000-0000-0000-0000-0000000001'||n)::uuid, u, 'T','0820000000',10 from (values ('01','$U1'::uuid),('02','$U2'::uuid),('03','$U3'::uuid),('04','$U3'::uuid)) v(n,u)" >/dev/null
q "insert into public.loyalty_transactions(user_id,txn_type,source_type,source_id,order_id,points,balance_after) values ('$U1','earn','order','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000101',1000,0),('$U2','earn','order','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000102',7,0),('$U3','earn','order','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000103',650,0),('$U3','redeem','order_redeem','00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000104',-200,0)" >/dev/null
[ "$(q "select points_balance from public.loyalty_accounts where user_id='$U1'")" = 1000 ] || { echo "FAIL: setup"; exit 1; }
echo "0. old-rate data in place"
for m in $A $B; do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$m.sql" >/dev/null 2>&1 || { echo "FAIL applying $m"; exit 1; }
done
chk() { [ "$(q "select points_balance||'/'||lifetime_points||'/'||(select code from public.loyalty_tiers where id=tier_id) from public.loyalty_accounts where user_id='$1'")" = "$2" ] || { echo "FAIL: $1 expected $2, got $(q "select points_balance||'/'||lifetime_points from public.loyalty_accounts where user_id='$1'")"; exit 1; }; }
chk $U1 "200/200/sprout"     # 1000/5 = 200 points, lifetime 200 -> Sprout (100+)
chk $U2 "1/1/seed"           # 7/5 = 1
chk $U3 "90/130/sprout"      # 450/5 = 90 ; lifetime 650/5 = 130
[ "$(q "select value from public.loyalty_rules where code='earn_rand_per_point'")" = 50 ] || { echo "FAIL: rate"; exit 1; }
[ "$(q "select string_agg(min_lifetime_points::text, ',' order by min_lifetime_points) from public.loyalty_tiers")" = "0,100,400,1000" ] || { echo "FAIL: tiers"; exit 1; }
[ "$(q "select count(*) from public.loyalty_transactions where source_type='points_conversion'")" = 3 ] || { echo "FAIL: conversion rows"; exit 1; }
[ "$(q "select count(*) from public.loyalty_rewards")" = 2 ] || { echo "FAIL: rewards"; exit 1; }
# the cached balance still equals the ledger
[ "$(q "select count(*) from public.loyalty_accounts a where a.points_balance <> (select coalesce(sum(points),0) from public.loyalty_transactions t where t.user_id=a.user_id)")" = 0 ] || { echo "FAIL: ledger diverged"; exit 1; }
echo "1. applied; points converted at 1 per R50, tiers rescaled, ledger consistent"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$B.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
chk $U1 "200/200/sprout"; chk $U3 "90/130/sprout"
echo "2. re-applied: nothing converted twice"
if run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${B}_rollback.sql" >/dev/null 2>&1; then echo "FAIL: rollback should be refused while a conversion exists"; exit 1; fi
echo "3. rollback refused while converted points exist"
# 4. On a database with nothing converted or used, the rollback works and the migrations re-apply.
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
run "$P -d postgres -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v b="$B" '{ n=$0; sub(/.*\//, "", n); if (n <= b ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${B}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='profiles' and column_name='username'")" = 0 ] || { echo "FAIL: username column remains"; exit 1; }
[ "$(q "select value from public.loyalty_rules where code='earn_rate_check' or code='earn_rand_per_point'")" = 10 ] || { echo "FAIL: old rate not back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('username_check','member_set_username','_referral_check','referral_code_check','member_rewards_summary','pos_customer_rewards')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${A}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back sources"; exit 1; }
echo "4. rolled back cleanly on a database that never used them"
for m in $A $B; do run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$m.sql" >/dev/null 2>&1 || { echo "FAIL re-applying $m"; exit 1; }; done
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
