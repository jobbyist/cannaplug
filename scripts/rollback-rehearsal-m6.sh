#!/usr/bin/env bash
# Rehearses the four Milestone 6 migrations' rollbacks on a scratch DB, newest first, exactly as they would be run
# in an emergency, then re-applies them. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_m6"
M=(20261004001000_public_forms 20261004002000_ai_quota 20261004003000_least_privilege_baseline 20261004004000_audit_hardening 20261004005000_email_automations 20261004006000_legacy_function_exposure)
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }

run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
echo "1. full schema built (all migrations)"
[ "$(q "select count(*) from information_schema.role_table_grants where table_schema='public' and grantee='anon' and table_name='audit_log'")" = 0 ] || { echo "FAIL: baseline grants not tightened"; exit 1; }

for ((i=${#M[@]}-1; i>=0; i--)); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M[$i]}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back ${M[$i]}"; exit 1; }
  echo "2.$((${#M[@]}-i)) rolled back ${M[$i]}"
done
[ "$(q "select count(*) from information_schema.tables where table_schema='public' and table_name in ('contact_submissions','newsletter_subscribers','ai_usage_counters')")" = 0 ] && echo "3. forms + ai-quota tables gone"
[ "$(q "select count(*) from information_schema.role_table_grants where table_schema='public' and grantee='anon' and table_name='audit_log' and privilege_type='SELECT'")" = 1 ] && echo "4. baseline grants restored (previous behaviour)"

for f in "${M[@]}"; do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$f.sql" >/dev/null 2>&1 || { echo "FAIL re-applying $f"; exit 1; }
done
echo "5. all four migrations re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
