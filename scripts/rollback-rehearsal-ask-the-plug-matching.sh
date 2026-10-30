#!/usr/bin/env bash
# Rehearses 20261031004000_ask_the_plug_matching: apply, only products with stock at or above the safety buffer are
# offered (offline and recommendation-only products never are), the buffer setting is validated and manager-only,
# a sold-out Reserve raises one recount alert, browser roles are refused, re-apply
# changes nothing, rollback is refused while a product is flagged, then runs clean, re-apply. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_ask_the_plug_matching"
M=20261031004000_ask_the_plug_matching
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
M_ID=33333333-3333-3333-3333-333333333333
MGR=11111111-1111-1111-1111-111111111111
q "insert into auth.users (id, email) values ('$MGR','m@x.co')" >/dev/null
q "insert into public.user_roles (user_id, role) values ('$MGR','manager')" >/dev/null
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
mkp() { q "insert into public.products (id, slug, name, category, price_rand) values ('$1','p-$1','Product $1','Flower',50)" >/dev/null; }
rcv() { q "select public.receive_stock('$MGR','$1','B-$1',$2,null,null,null,'rcv-$1')" >/dev/null; }
OK=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa; ONE=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb; OFF=cccccccc-cccc-4ccc-8ccc-cccccccccccc; MED=dddddddd-dddd-4ddd-8ddd-dddddddddddd
for p in $OK $ONE $OFF $MED; do mkp $p; done
rcv $OK 5; rcv $ONE 1; rcv $OFF 9; rcv $MED 9
q "update public.products set sell_online=false where id='$OFF'" >/dev/null
q "update public.products set requires_recommendation=true where id='$MED'" >/dev/null
GOT=$(q "select string_agg(id::text, ',' order by id) from public.plug_match_candidates(null)")
[ "$GOT" = "$OK" ] || { echo "FAIL: only the in-stock product above the buffer is offered (got: $GOT)"; exit 1; }
q "select public.plug_settings_set('$MGR',1,4,10,'set-key-0001')" >/dev/null
[ "$(q "select count(*) from public.plug_match_candidates(null) where id='$ONE'")" = 1 ] || { echo "FAIL: buffer 1 offers one unit"; exit 1; }
if q "select public.plug_settings_set('$MGR',5,2,10,'set-key-0002')" >/dev/null 2>&1; then echo "FAIL: fast buffer below normal"; exit 1; fi
q "select public.plug_settings_set('$MGR',2,4,10,'set-key-0003')" >/dev/null
q "select public.plug_match_log('reserve_stock_fail','sold_out','{}'::jsonb, array['$OK']::uuid[])" >/dev/null
q "select public.plug_match_log('reserve_stock_fail','sold_out','{}'::jsonb, array['$OK']::uuid[])" >/dev/null
[ "$(q "select count(*) from public.team_notifications where source_key='alert:plug-stock:$OK'")" = 1 ] || { echo "FAIL: one recount alert"; exit 1; }
for role in anon authenticated; do
  if q "set role $role; select * from public.plug_settings" >/dev/null 2>&1; then echo "FAIL: $role reads settings"; exit 1; fi
  if q "set role $role; select * from public.plug_match_candidates(null)" >/dev/null 2>&1; then echo "FAIL: $role reads candidates"; exit 1; fi
  if q "set role $role; select public.plug_settings_set('$MGR',3,4,10,'set-key-0004')" >/dev/null 2>&1; then echo "FAIL: $role sets"; exit 1; fi
done
echo "1. applied: hard filters and buffer hold, settings validated, one recount alert, browser roles refused"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select buffer_default from public.plug_settings")" = 2 ] || { echo "FAIL: re-apply reset the settings"; exit 1; }
echo "2. re-applied: settings unchanged"
echo "3. rollback is refused while a product is flagged requires_recommendation"
if apply "$ROOT/supabase/rollbacks/${M}_rollback.sql"; then echo "FAIL: rollback must refuse with flagged products"; exit 1; fi
q "update public.products set requires_recommendation=false" >/dev/null
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('plug_match_candidates','plug_settings_set','plug_match_log','_plug_units_7d')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
[ "$(q "select count(*) from information_schema.tables where table_name in ('plug_settings','plug_match_events')")" = 0 ] || { echo "FAIL: tables remain"; exit 1; }
[ "$(q "select count(*) from information_schema.columns where table_name='products' and column_name='requires_recommendation'")" = 0 ] || { echo "FAIL: column remains"; exit 1; }
echo "   rolled back"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
