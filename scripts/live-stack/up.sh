#!/usr/bin/env bash
# Brings up a LOCAL Supabase-equivalent stack for the live browser tests (test-only; never touches hosted):
#   Postgres 16 (wal_level=logical) :54330  ->  GoTrue :9999, PostgREST :3000, Realtime :4000  ->  gateway :54321
# Prereqs: a running Docker daemon, apt package postgresql-16-wal2json (Realtime 2.33 decodes with wal2json),
# and the images below (pulled from Supabase's public ECR mirror; Docker Hub may rate-limit).
# Afterwards:  . /tmp/live.env && . scripts/live-stack/app-env.sh && bun run dev --host 127.0.0.1 --port 4173
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
D="${LIVE_PGDATA:-/var/tmp/live-pgdata}"
PORT=54330
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
PSQL="$PGBIN/psql -X -q -h 127.0.0.1 -p $PORT -U postgres"

[ -f /usr/lib/postgresql/16/lib/wal2json.so ] || { echo "missing: apt-get install postgresql-16-wal2json"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker daemon not running (try: nohup dockerd &)"; exit 1; }
for img in postgrest:v12.2.3 gotrue:v2.158.1 realtime:v2.33.58; do
  docker image inspect public.ecr.aws/supabase/$img >/dev/null 2>&1 || docker pull -q public.ecr.aws/supabase/$img
done

# 1. Postgres
if [ ! -d "$D" ]; then
  mkdir -p "$D"; [ "$(id -u)" = 0 ] && chown postgres "$D"
  run "$PGBIN/initdb -D $D -A trust -U postgres >/dev/null"
fi
run "$PGBIN/pg_ctl -D $D status >/dev/null 2>&1" || run "$PGBIN/pg_ctl -D $D -o '-p $PORT -k /tmp -c fsync=off -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10 -c listen_addresses=127.0.0.1 -c max_connections=200' -l $D/log -w start" >/dev/null

# 2. keys + fresh database
node "$ROOT/scripts/live-stack/keys.mjs" | sed 's/^export //' > /tmp/live.env
set -a; . /tmp/live.env; set +a
docker rm -f live-gotrue live-postgrest live-realtime >/dev/null 2>&1 || true
run "$PSQL -d postgres -c 'DROP DATABASE IF EXISTS live WITH (FORCE)' -c 'CREATE DATABASE live'" 2>&1 | grep -v NOTICE || true
run "$PSQL -d live -v ON_ERROR_STOP=1 -f $ROOT/scripts/live-stack/prepare-db.sql"

# 3. GoTrue (creates the real auth schema)
docker run -d --name live-gotrue --network host \
  -e GOTRUE_API_HOST=127.0.0.1 -e PORT=9999 -e API_EXTERNAL_URL=http://127.0.0.1:54321 \
  -e GOTRUE_DB_DRIVER=postgres -e "GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:live-pass@127.0.0.1:$PORT/live?search_path=auth" \
  -e GOTRUE_SITE_URL=http://127.0.0.1:4173 -e GOTRUE_URI_ALLOW_LIST=http://127.0.0.1:4173 \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated -e GOTRUE_JWT_ADMIN_ROLES=service_role \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=true \
  public.ecr.aws/supabase/gotrue:v2.158.1 >/dev/null
for i in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:9999/health >/dev/null && break; sleep 1; done

# 4. the app's migrations (after auth exists, as on hosted)
for f in $(ls "$ROOT"/supabase/migrations/*.sql | sort); do
  run "$PSQL -d live -v ON_ERROR_STOP=1 -f $f" >/dev/null 2>/tmp/live-mig.err || { echo "FAIL applying $f"; grep -v NOTICE /tmp/live-mig.err | head; exit 1; }
done

# 5. PostgREST + Realtime (IPv4-patched runtime: sandboxes without IPv6 cannot bind :inet6)
docker run -d --name live-postgrest --network host \
  -e PGRST_DB_URI="postgres://authenticator:live-pass@127.0.0.1:$PORT/live" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_SERVER_PORT=3000 \
  public.ecr.aws/supabase/postgrest:v12.2.3 >/dev/null
docker run -d --name live-realtime --network host -v "$ROOT/scripts/live-stack/realtime-runtime.ipv4.exs:/app/releases/2.33.58/runtime.exs:ro" \
  -e PORT=4000 -e DB_HOST=127.0.0.1 -e DB_PORT=$PORT -e DB_USER=supabase_admin -e DB_PASSWORD=live-pass -e DB_NAME=live \
  -e DB_AFTER_CONNECT_QUERY='SET search_path TO _realtime' -e DB_ENC_KEY=supabaserealtime -e API_JWT_SECRET="$JWT_SECRET" \
  -e FLY_ALLOC_ID=fly123 -e FLY_APP_NAME=realtime -e SECRET_KEY_BASE=UpNVntn3cDxHJpq99YMc1T1AQgQpc8kfYTuRgBiYa15BLrx8etQoXz3gZv1/u2oq \
  -e ERL_AFLAGS="-proto_dist inet_tcp" -e ENABLE_TAILSCALE=false -e DNS_NODES="''" -e RLIMIT_NOFILE=10000 -e APP_NAME=realtime \
  -e SEED_SELF_HOST=true -e RUN_JANITOR=true \
  public.ecr.aws/supabase/realtime:v2.33.58 >/dev/null
for i in $(seq 1 60); do curl -sf -m 2 -o /dev/null http://127.0.0.1:4000/ && break; sleep 1; done

# 6. gateway (Kong stand-in)
[ -f /tmp/gateway.pid ] && kill "$(cat /tmp/gateway.pid)" 2>/dev/null || true
nohup node "$ROOT/scripts/live-stack/gateway.mjs" 54321 > /tmp/gateway.log 2>&1 &
echo $! > /tmp/gateway.pid
sleep 8   # let Realtime finish preparing replication
echo "stack up: gateway http://127.0.0.1:54321  (keys in /tmp/live.env)"
