#!/usr/bin/env bash
# Rehearses the Milestone 4 rollback on a scratch database: records the Milestone 3 POS function
# definitions, applies M4, rolls it back, proves the originals are restored and the M4 objects are
# gone, then re-applies M4. Requires the local test cluster (scripts/test-db.sh start).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_m4"
M4="20260930001000_member_account_live"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
HASH="select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('accrue_pos_loyalty','pos_refund_sale')"

run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | grep -v "$M4"); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
before=$(run "$P -At -d $DB -c \"$HASH\"")
echo "1. pre-M4 schema built; M3 POS function hash $before"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M4.sql" >/dev/null 2>&1
changed=$(run "$P -At -d $DB -c \"$HASH\"")
[ "$changed" != "$before" ] && echo "2. M4 applied (POS functions now rule-driven, hash differs)" || { echo "FAIL: M4 did not change POS functions"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M4}_rollback.sql" >/dev/null
after=$(run "$P -At -d $DB -c \"$HASH\"")
[ "$after" = "$before" ] && echo "3. rollback restored the M3 POS functions byte-for-byte" || { echo "FAIL: POS functions differ after rollback"; exit 1; }
left=$(run "$P -At -d $DB -c \"select count(*) from information_schema.tables where table_schema='public' and table_name in ('loyalty_accounts','loyalty_transactions','loyalty_tiers','loyalty_rules','wishlist_items','back_in_stock_subscriptions')\"")
cols=$(run "$P -At -d $DB -c \"select count(*) from information_schema.columns where table_schema='public' and table_name='orders' and column_name like 'loyalty_%'\"")
fns=$(run "$P -At -d $DB -c \"select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('redeem_loyalty_points','create_reorder','reorder_check','member_save_address','accrue_order_loyalty','claim_back_in_stock_notifications')\"")
echo "4. leftover M4 tables: $left, order columns: $cols, functions: $fns"
[ "$left" = 0 ] && [ "$cols" = 0 ] && [ "$fns" = 0 ] || { echo "FAIL: leftovers"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M4.sql" >/dev/null 2>&1 && echo "5. migration re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'"
