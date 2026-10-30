#!/usr/bin/env bash
# Rehearses 20261031005000_outdoor_batches: an Outdoor product that already exists is moved to a 5 g step, a new Outdoor
# product is kept at 5 g by the trigger, a Greenhouse product and a bag sold as one unit are left alone, the step check
# allows 0.5 / 1 / 5, re-applying changes nothing, the rollback puts everything back to 1 g, drops the triggers and
# narrows the check, and the migration applies again afterwards. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_outdoor_batches"
M=20261031005000_outdoor_batches
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
apply() { run "$P -d $DB -v ON_ERROR_STOP=1 -f $1" >/dev/null 2>&1; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  apply "$f" || { echo "FAIL applying $f"; exit 1; }
done
q "insert into public.products (slug, name, category, subcategory, price_rand, unit, sold_by_weight, weight_step_g) values
   ('rh-out','Rehearsal Grape (Outdoor)','Flower','Outdoor',24,'g',true,1),
   ('rh-gh','Rehearsal Haze (Greenhouse)','Flower','Greenhouse',50,'g',true,1),
   ('rh-bag','Rehearsal Bag (Outdoor)','Flower','Outdoor',120,'5g',false,1)" >/dev/null
echo "0. database before the migration is ready"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL applying $M"; exit 1; }
step() { q "select weight_step_g from public.products where slug='$1'"; }
[ "$(step rh-out)" = 5.0 ] || { echo "FAIL: existing Outdoor product not moved to 5 g"; exit 1; }
[ "$(step rh-gh)" = 1.0 ] || { echo "FAIL: Greenhouse changed"; exit 1; }
[ "$(step rh-bag)" = 1.0 ] || { echo "FAIL: a bag sold as one unit changed"; exit 1; }
q "insert into public.products (slug, name, category, subcategory, price_rand, unit, sold_by_weight, weight_step_g) values ('rh-new','Rehearsal New (Outdoor)','Flower','Outdoor',24,'g',true,1)" >/dev/null
[ "$(step rh-new)" = 5.0 ] || { echo "FAIL: new Outdoor product not kept at 5 g"; exit 1; }
for ok in 0.5 1 5; do q "update public.products set weight_step_g=$ok where slug='rh-gh'" >/dev/null || { echo "FAIL: step $ok refused"; exit 1; }; done
if q "update public.products set weight_step_g=2 where slug='rh-gh'" >/dev/null 2>&1; then echo "FAIL: step 2 allowed"; exit 1; fi
echo "1. applied: Outdoor at 5 g, others untouched, check allows 0.5 / 1 / 5"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying"; exit 1; }
[ "$(step rh-out)" = 5.0 ] || { echo "FAIL: re-apply changed data"; exit 1; }
echo "2. re-applied: nothing changed"
apply "$ROOT/supabase/rollbacks/${M}_rollback.sql" || { echo "FAIL rolling back"; exit 1; }
[ "$(step rh-out)" = 1.0 ] && [ "$(step rh-new)" = 1.0 ] || { echo "FAIL: steps not put back to 1 g"; exit 1; }
[ "$(q "select count(*) from pg_trigger where tgname in ('order_items_sale_step','pos_sale_items_sale_step','products_outdoor_step')")" = 0 ] || { echo "FAIL: triggers remain"; exit 1; }
[ "$(q "select count(*) from pg_proc where proname in ('_sale_step','_enforce_sale_step','_is_outdoor_flower','_products_outdoor_step')")" = 0 ] || { echo "FAIL: functions remain"; exit 1; }
if q "update public.products set weight_step_g=5 where slug='rh-gh'" >/dev/null 2>&1; then echo "FAIL: 5 g still allowed after rollback"; exit 1; fi
echo "3. rolled back: back to 1 g, triggers and functions gone, check narrowed"
apply "$ROOT/supabase/migrations/$M.sql" || { echo "FAIL re-applying after rollback"; exit 1; }
[ "$(step rh-out)" = 5.0 ] || { echo "FAIL: Outdoor not 5 g after re-apply"; exit 1; }
echo "4. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
