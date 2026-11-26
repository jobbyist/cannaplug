#!/usr/bin/env bash
# Rehearses 20261126001000_black_friday_2026: applies on top of every earlier migration, ordering opens up for members without a
# verified ID (a rejected ID is still stopped), the campaign window and scheduled sales work, re-applying changes nothing, the
# rollback restores the old ID gate and the 10-tube rule, and the migration applies again afterwards.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_black_friday"
M=20261126001000_black_friday_2026
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
U=00000000-0000-0000-0000-0000000000b1
q "insert into auth.users (id, email) values ('$U','bf@test.local')" >/dev/null
echo "0. database before the migration is ready"
[ "$(q "select (select count(*) from pg_proc where proname='_require_verified_member') = 1")" = t ] || { echo "FAIL: gate missing"; exit 1; }
if q "select public._require_verified_member('$U')" >/dev/null 2>&1; then echo "FAIL: gate should refuse before the migration"; exit 1; fi
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
q "select public._require_verified_member('$U')" >/dev/null || { echo "FAIL: a member with no ID cannot order after the migration"; exit 1; }
q "insert into public.customer_verification (user_id, status) values ('$U','rejected')" >/dev/null
if q "select public._require_verified_member('$U')" >/dev/null 2>&1; then echo "FAIL: a rejected ID must still be refused"; exit 1; fi
[ "$(q "select public.bfcm_campaign_active('2026-11-27 00:00:00+02') and not public.bfcm_campaign_active('2026-12-01 00:00:00+02') and not public.bfcm_campaign_active('2026-11-26 23:59:59+02')")" = t ] || { echo "FAIL: window"; exit 1; }
[ "$(q "select count(*) from pg_class where relname='scheduled_sales' and relrowsecurity")" = 1 ] || { echo "FAIL: scheduled_sales missing or RLS off"; exit 1; }
[ "$(q "select count(*) from information_schema.role_table_grants where table_name='scheduled_sales' and grantee in ('anon','authenticated')")" = 0 ] || { echo "FAIL: browser grants"; exit 1; }
echo "1. applied: open ordering, rejected still stopped, window, scheduled_sales with RLS and no browser grants"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
echo "2. re-applied"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
q "update public.customer_verification set status='unverified' where user_id='$U'" >/dev/null
if q "select public._require_verified_member('$U')" >/dev/null 2>&1; then echo "FAIL: the old gate should refuse again after rollback"; exit 1; fi
[ "$(q "select public.plug_back_tubes_per_reward()")" = 10 ] || { echo "FAIL: rule is not 10 tubes after rollback"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('bfcm_campaign_active','products_start_due_sales','schedule_black_friday_2026')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
echo "3. rolled back: ID gate and 10-tube rule restored, campaign functions gone"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
