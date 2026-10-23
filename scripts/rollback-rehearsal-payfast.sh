#!/usr/bin/env bash
# Rehearses 20261023005000_payfast_eft: apply all -> roll back (Yoco checks back) -> re-apply. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_payfast"
M=20261023005000_payfast_eft
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
C="$(q "select pg_get_constraintdef(oid) from pg_constraint where conname='payment_transactions_provider_check'")"; case "$C" in *payfast*) ;; *) echo "FAIL: payfast not allowed ($C)"; exit 1;; esac
[ "$(q "select count(*) from pg_proc where proname='payment_set_eft_details'")" = 1 ] || { echo "FAIL: eft function missing"; exit 1; }
echo "1. applied; provider check allows payfast, EFT details function present"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
C="$(q "select pg_get_constraintdef(oid) from pg_constraint where conname='payment_transactions_provider_check'")"; case "$C" in *yoco*) ;; *) echo "FAIL: yoco check not restored"; exit 1;; esac
[ "$(q "select count(*) from pg_proc where proname='payment_set_eft_details'")" = 0 ] || { echo "FAIL: eft function remains"; exit 1; }
echo "2. rolled back; yoco check and original functions restored"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
