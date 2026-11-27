#!/usr/bin/env bash
# Rehearses 20261127003000_billing_due_email: apply all -> a bill due tomorrow queues a manager email -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_billing_due_email"
M=20261127003000_billing_due_email
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
q "insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000a1', 'manager@rehearsal.test')" >/dev/null
q "insert into public.user_roles (user_id, role) values ('00000000-0000-4000-8000-0000000000a1', 'manager')" >/dev/null
q "update public.billing_accounts set anchor_date = (now() at time zone 'Africa/Johannesburg')::date + 1 where slug = 'shopify-admin-api'" >/dev/null
q "select public.billing_due_alerts_refresh()" >/dev/null
[ "$(q "select count(*) from public.notification_events where template = 'staff_billing_due'")" = 1 ] || { echo "FAIL: due email not queued"; exit 1; }
echo "1. applied; a bill due tomorrow queues one manager email"
q "delete from public.notification_events where template = 'staff_billing_due'" >/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
q "select public.billing_due_alerts_refresh()" >/dev/null
[ "$(q "select count(*) from public.notification_events where template = 'staff_billing_due'")" = 0 ] || { echo "FAIL: email still queued after rollback"; exit 1; }
[ "$(q "select count(*) from public.team_notifications where source_key = 'alert:bill-due:shopify-admin-api' and status = 'published'")" = 1 ] || { echo "FAIL: bell alert lost after rollback"; exit 1; }
echo "2. rolled back; the bell alert stays, no email"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
q "select public.billing_due_alerts_refresh()" >/dev/null
[ "$(q "select count(*) from public.notification_events where template = 'staff_billing_due'")" = 1 ] || { echo "FAIL: email not queued after re-apply"; exit 1; }
echo "3. re-applied after rollback; the email queues again"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
