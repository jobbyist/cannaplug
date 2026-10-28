#!/usr/bin/env bash
# Rehearses 20261029004000_product_subcategories: apply the earlier migrations -> add products named with a grade ->
# apply this one -> grades filled in -> roll back -> re-apply. Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_product_subcategories"
M=20261029004000_product_subcategories
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n < m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
q "insert into public.products (slug, name, category, price_rand, subcategory) values
  ('rh-a', 'Test A (Greenhouse)', 'Flower', 50, null),
  ('rh-b', 'Test B Stick (Entry Indoor)', 'Pre-rolls', 100, null),
  ('rh-c', 'Test C (Top Shelf)', 'Accessories', 10, null),
  ('rh-d', 'Test D', 'Flower', 50, null),
  ('rh-e', 'Test E (Top Shelf)', 'Flower', 120, ' top   shelf '),
  ('rh-f', 'Test F (Outdoor)', 'Flower', 24, 'Hand picked'),
  ('rh-g', 'Test G Stick (Greendoor 2-in-1)', 'Pre-rolls', 150, null),
  ('rh-h', 'Test H (Indoor)', 'Flower', 110, null),
  ('rh-i', 'Test I (Hydro)', 'Flower', 130, null),
  ('rh-j', 'Test J (Premium Indoor)', 'Flower', 130, null)" >/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL applying $M"; exit 1; }
sub() { q "select coalesce(subcategory,'-') from public.products where slug='$1'"; }
[ "$(sub rh-a)" = "Greenhouse" ] || { echo "FAIL: Greenhouse not filled"; exit 1; }
[ "$(sub rh-b)" = "Entry Indoor" ] || { echo "FAIL: Entry Indoor was renamed"; exit 1; }
[ "$(sub rh-h)" = "Indoor" ] && [ "$(sub rh-i)" = "Hydro" ] && [ "$(sub rh-j)" = "Premium Indoor" ] || { echo "FAIL: Indoor, Hydro or Premium Indoor not filled"; exit 1; }
[ "$(sub rh-c)" = "-" ] || { echo "FAIL: accessory got a grade"; exit 1; }
[ "$(sub rh-d)" = "-" ] || { echo "FAIL: product with no grade got one"; exit 1; }
[ "$(sub rh-e)" = "Top Shelf" ] || { echo "FAIL: spelling not tidied"; exit 1; }
[ "$(sub rh-f)" = "Hand picked" ] || { echo "FAIL: a chosen subcategory was overwritten"; exit 1; }
[ "$(sub rh-g)" = "Greendoor 2-in-1" ] || { echo "FAIL: 2-in-1 not filled"; exit 1; }
echo "1. applied; grades filled from names, spellings tidied, others untouched"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(sub rh-a)" = "-" ] && [ "$(sub rh-b)" = "-" ] && [ "$(sub rh-g)" = "-" ] && [ "$(sub rh-h)" = "-" ] && [ "$(sub rh-i)" = "-" ] || { echo "FAIL: filled grades remain"; exit 1; }
[ "$(sub rh-f)" = "Hand picked" ] || { echo "FAIL: rollback touched a chosen subcategory"; exit 1; }
[ "$(q "select count(*) from pg_constraint where conname='products_subcategory_chk'")" = 0 ] || { echo "FAIL: check remains"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
[ "$(sub rh-a)" = "Greenhouse" ] || { echo "FAIL: not filled after re-apply"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
