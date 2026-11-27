#!/usr/bin/env bash
# Rehearses 20261127001000_loyalty_grade_fallback: before it, a "Prerolls" product graded by Subcategory (Purple Champagne)
# is not covered by the Indoor reward; applied, it is (and its category is tidied); re-applying changes nothing; rolling back
# restores the old rule (mutation check: the product is refused again); applying again works. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_loyalty_grade"
M=20261127001000_loyalty_grade_fallback
PC=55a14ee6-d450-48e4-8843-e5bb050e5303
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
echo "0. database before the migration is ready"
q "insert into public.products (id, slug, name, category, price_rand) values ('$PC','purple-champagne','Purple Champagne','Prerolls',100)" >/dev/null
q "insert into public.products (id, slug, name, category, price_rand) values (gen_random_uuid(),'gelato','Blue Gelato (Greenhouse)','Flower',50)" >/dev/null
[ "$(q "select public._reward_eligible('indoor_free','$PC')")" = f ] || { echo "FAIL: should be refused before"; exit 1; }
echo "1. before: Purple Champagne is not covered by the Indoor reward"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
[ "$(q "select category||'/'||subcategory from public.products where id='$PC'")" = "Pre-rolls/Entry Indoor" ] || { echo "FAIL: data fix"; exit 1; }
[ "$(q "select public._reward_eligible('indoor_free','$PC')")" = t ] || { echo "FAIL: should be covered after"; exit 1; }
[ "$(q "select count(*) from public.products where name='Blue Gelato (Greenhouse)' and public._reward_eligible('greenhouse_free', id)")" = 1 ] || { echo "FAIL: bracket rule broke"; exit 1; }
echo "2. applied: category tidied, Purple Champagne covered, bracket rule intact"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select public._reward_eligible('indoor_free','$PC')")" = t ] || { echo "FAIL: re-apply changed result"; exit 1; }
echo "3. re-applied: nothing changed"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select public._reward_eligible('indoor_free','$PC')")" = f ] || { echo "FAIL: rollback should restore the old rule"; exit 1; }
[ "$(q "select count(*) from public.products where name='Blue Gelato (Greenhouse)' and public._reward_eligible('greenhouse_free', id)")" = 1 ] || { echo "FAIL: rollback broke the bracket rule"; exit 1; }
echo "4. rolled back: the old rule is back (mutation check: the new rule is what covers Purple Champagne)"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
[ "$(q "select public._reward_eligible('indoor_free','$PC')")" = t ] || { echo "FAIL: after re-apply"; exit 1; }
echo "5. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
