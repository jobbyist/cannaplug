#!/usr/bin/env bash
# Stops the local live-test stack (containers, gateway). Leaves the Postgres data dir for reuse.
docker rm -f live-gotrue live-postgrest live-realtime live-storage >/dev/null 2>&1 || true
[ -f /tmp/gateway.pid ] && kill "$(cat /tmp/gateway.pid)" 2>/dev/null || true
echo stopped
