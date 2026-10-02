#!/usr/bin/env bash
# Rehearses the payments/notifications rollback on a scratch DB: records the two gated functions as they were
# before Milestone 5, applies the migration, rolls it back, proves they are restored byte-for-byte and that every
# new table/function is gone, then re-applies. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_payments"
MIG="20261003001000_payments_notifications"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
FN="select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('checkout_place_order','transition_order_status')"
TABLES="select count(*) from information_schema.tables where table_schema='public' and table_name in ('payment_transactions','webhook_events','webhook_rejections','fx_rates','payment_settings','notification_events')"
FUNCS="select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('payment_initiate','payments_apply_verified_event','eft_submit','eft_approve','notification_claim','fx_record_live_rate','_notify_order_status')"

run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | grep -v "$MIG"); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
fn0=$(run "$P -At -d $DB -c \"$FN\"")
echo "1. pre-payments schema built"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1
[ "$(run "$P -At -d $DB -c \"$FN\"")" != "$fn0" ] && [ "$(run "$P -At -d $DB -c \"$TABLES\"")" = 6 ] && echo "2. migration applied (6 tables, functions changed)" || { echo "FAIL: migration did not apply"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${MIG}_rollback.sql" >/dev/null
[ "$(run "$P -At -d $DB -c \"$FN\"")" = "$fn0" ] && echo "3. rollback restored both functions byte-for-byte" || { echo "FAIL: functions differ"; exit 1; }
[ "$(run "$P -At -d $DB -c \"$TABLES\"")" = 0 ] && echo "4. payment/notification tables gone" || { echo "FAIL: tables remain"; exit 1; }
[ "$(run "$P -At -d $DB -c \"$FUNCS\"")" = 0 ] && echo "5. payment/notification functions gone" || { echo "FAIL: functions remain"; exit 1; }
trg=$(run "$P -At -d $DB -c \"select count(*) from pg_trigger where tgname='order_status_history_notify'\"")
[ "$trg" = 0 ] && echo "6. order notification trigger gone" || { echo "FAIL: trigger remains"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1 && echo "7. migration re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'"
