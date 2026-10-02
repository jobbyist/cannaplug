#!/usr/bin/env bash
# One command that proves a release candidate: the same gates CI runs, locally.
#   scripts/verify-release.sh            full run (needs PostgreSQL 16 server binaries; see scripts/test-db.sh)
#   scripts/verify-release.sh --quick    skip the database suites and rehearsals
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
step "typecheck";  bun run typecheck
step "lint";       bun run lint
step "unit tests (incl. security audit, providers, notifications, chat, newsroom)"; bun run test
if [ "${1:-}" != "--quick" ]; then
  step "database tests (real PostgreSQL, every migration)"; bun run test:db
  step "migration + rollback rehearsals"
  scripts/test-db.sh start >/dev/null
  for s in rollback-rehearsal-m4 rollback-rehearsal-m5b rollback-rehearsal-payments rollback-rehearsal-m6; do bash "scripts/$s.sh"; done
fi
step "production build"; bun run build
step "dependency audit (critical gate; high/moderate are dev-toolchain only, see docs/release/audit.md)"; bun audit --audit-level=critical || true
printf '\nRelease candidate verified.\n'
