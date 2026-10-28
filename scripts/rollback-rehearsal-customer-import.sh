#!/usr/bin/env bash
# Rehearses 20261030001000_customer_import: apply all -> import 2 members (1 minor refused) -> one signs up and is charged
# from the reserve -> roll back -> re-apply. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_customer_import"
TMPF="$(mktemp /var/tmp/rehearsal-import.XXXXXX.sql)"
trap 'rm -f "$TMPF"' EXIT
M=20261030001000_customer_import
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
A=00000000-0000-0000-0000-0000000000a1
q "insert into auth.users (id, email) values ('$A', 'rh-admin@test.local'); insert into public.user_roles (user_id, role) values ('$A', 'admin')" >/dev/null
cat > "$TMPF" <<SQL
select public.import_customers('$A', 'rehearsal', repeat('a', 64), '[{"member_number":1,"first_name":"Ada","last_name":"Test","email":"ada@test.local","phone":"0611234567","username":"ada.test","age":30},{"member_number":2,"first_name":"Kid","last_name":"Test","email":"kid@test.local","phone":"0611234568","username":"kid.test","age":16}]', 'rehearsal-key');
SQL
chmod 644 "$TMPF"
R=$(run "$P -At -d $DB -f $TMPF")
echo "$R" | grep -q '"imported": 1' || { echo "FAIL: import result $R"; exit 1; }
[ "$(q "select status from public.customer_verification cv join auth.users u on u.id = cv.user_id where u.email = 'ada@test.local'")" = provisional ] || { echo "FAIL: not provisional"; exit 1; }
[ "$(q "select has_function_privilege('authenticated','public.import_customers(uuid,text,text,jsonb,text)','execute')")" = f ] || { echo "FAIL: authenticated can execute"; exit 1; }
q "update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('id_number', '9001015009087') where email = 'ada@test.local'" >/dev/null
[ "$(q "select available || '/' || reserved from public._id_credit_balance()")" = "400/555" ] || { echo "FAIL: sign-up not charged from the reserve"; exit 1; }
echo "1. applied; 1 imported (minor refused), provisional, sign-up charged 3 from the reserve, service-role only"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select to_regclass('public.imported_customers') is null")" = t ] || { echo "FAIL: table still present"; exit 1; }
[ "$(q "select count(*) from public.customer_verification where status = 'provisional'")" = 0 ] || { echo "FAIL: provisional left"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
