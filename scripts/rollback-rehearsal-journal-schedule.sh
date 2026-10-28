#!/usr/bin/env bash
# Rehearses 20261028007000_journal_scheduled_articles: apply all -> three scheduled articles -> roll back -> re-apply.
# Needs scripts/test-db.sh start.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PORT="${TEST_PGPORT:-54329}"
DB="rollback_rehearsal_journal_sched"
M=20261028007000_journal_scheduled_articles
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
P="$PG_BIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"
q() { run "$P -At -d $DB -c \"$1\""; }
run "$P -d postgres -c 'DROP DATABASE IF EXISTS $DB WITH (FORCE)' -c 'CREATE DATABASE $DB'" 2>/dev/null
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/local/bootstrap.sql" >/dev/null 2>&1
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort | awk -v m="$M" '{ n=$0; sub(/.*\//, "", n); if (n <= m ".sql") print }'); do
  run "$P -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>&1 || { echo "FAIL applying $f"; exit 1; }
done
[ "$(q "select count(*) from public.articles where slug in ('cannabis-etiquette-south-africa-considerate-consumer','flower-pre-rolls-edibles-product-formats-explained','what-to-look-for-in-a-trustworthy-cannabis-store') and published_at in ('2026-10-29 06:00+00','2026-10-30 06:00+00','2026-10-31 06:00+00')")" = 3 ] || { echo "FAIL: scheduled articles missing or wrongly timed"; exit 1; }
echo "1. applied; three articles scheduled for 8 AM SAST"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/rollbacks/${M}_rollback.sql" >/dev/null 2>&1 || { echo "FAIL rolling back"; exit 1; }
[ "$(q "select count(*) from public.articles where slug in ('cannabis-etiquette-south-africa-considerate-consumer','flower-pre-rolls-edibles-product-formats-explained','what-to-look-for-in-a-trustworthy-cannabis-store')")" = 0 ] || { echo "FAIL: articles remain"; exit 1; }
[ "$(q "select count(*) from public.articles where author_name='Dithekgo M.'")" = 4 ] || { echo "FAIL: launch articles touched"; exit 1; }
echo "2. rolled back"
run "$P -d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/migrations/$M.sql" >/dev/null 2>&1 || { echo "FAIL re-applying"; exit 1; }
[ "$(q "select count(*) from public.articles where author_name='Dithekgo M.'")" = 7 ] || { echo "FAIL: articles after re-apply"; exit 1; }
echo "3. re-applied after rollback"
run "$P -d postgres -c 'DROP DATABASE $DB WITH (FORCE)'" 2>/dev/null
