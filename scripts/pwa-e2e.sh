#!/usr/bin/env bash
# Production-build PWA check: builds with the node-server preset (Vercel picks its own preset automatically),
# serves it on :4173 and runs e2e/pwa.spec.ts against it.
set -euo pipefail
cd "$(dirname "$0")/.."
export SUPABASE_URL=${SUPABASE_URL:-http://127.0.0.1:54321} SUPABASE_PUBLISHABLE_KEY=${SUPABASE_PUBLISHABLE_KEY:-ci-placeholder}
export VITE_SUPABASE_URL=${VITE_SUPABASE_URL:-$SUPABASE_URL} VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY:-ci-placeholder} VITE_SUPABASE_PROJECT_ID=${VITE_SUPABASE_PROJECT_ID:-ci}
NITRO_PRESET=node-server bunx vite build >/dev/null
PORT=4173 HOST=127.0.0.1 node .output/server/index.mjs >/tmp/pwa-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:4173/offline >/dev/null && break; sleep 0.5; done
PWA_E2E=1 PWA_SERVER_PID=$SERVER bunx playwright test e2e/pwa.spec.ts --workers=1 "$@"
