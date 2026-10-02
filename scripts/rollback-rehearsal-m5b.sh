#!/usr/bin/env bash
# Rehearses the ID-verification EXPIRY rollback on a scratch DB: records the part-1 definitions of the three
# changed functions and the customer_verification columns/constraints, applies the migration, rolls it back,
# proves they are restored byte-for-byte and the new objects are gone, then re-applies. Needs test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_m5b"
MIG="20260930004000_id_verification_expiry"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
FN="select md5(string_agg(pg_get_functiondef(p.oid), '' order by p.proname)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('_require_verified_member','verification_submit','verification_review')"
NFN="select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='verification_submit'"
COLS="select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema='public' and table_name='customer_verification'"
CONS="select string_agg(conname, ',' order by conname) from pg_constraint where conrelid='public.customer_verification'::regclass"

run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | grep -v "$MIG"); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
fn0=$(run "$P -At -d $DB -c \"$FN\""); col0=$(run "$P -At -d $DB -c \"$COLS\""); con0=$(run "$P -At -d $DB -c \"$CONS\"")
echo "1. part-1 schema built (verification_submit overloads: $(run "$P -At -d $DB -c \"$NFN\""))"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1
[ "$(run "$P -At -d $DB -c \"$FN\"")" != "$fn0" ] && echo "2. migration applied (functions changed; overloads: $(run "$P -At -d $DB -c \"$NFN\""))" || { echo "FAIL: functions unchanged"; exit 1; }
[ "$(run "$P -At -d $DB -c \"$NFN\"")" = 1 ] || { echo "FAIL: old verification_submit overload left behind"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${MIG}_rollback.sql" >/dev/null
[ "$(run "$P -At -d $DB -c \"$FN\"")" = "$fn0" ] && echo "3. rollback restored all three functions byte-for-byte" || { echo "FAIL: functions differ"; exit 1; }
[ "$(run "$P -At -d $DB -c \"$COLS\"")" = "$col0" ] && echo "4. columns restored" || { echo "FAIL: columns differ"; exit 1; }
[ "$(run "$P -At -d $DB -c \"$CONS\"")" = "$con0" ] && echo "5. constraints restored" || { echo "FAIL: constraints differ"; exit 1; }
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$MIG.sql" >/dev/null 2>&1 && echo "6. migration re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'"
