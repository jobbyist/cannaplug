# Live browser test stack (local, disposable)

Real Chromium driving the real app against a real local Supabase-equivalent stack — GoTrue auth, PostgREST
with the real RLS/column grants, Realtime over websockets (wal2json), Storage (private buckets, signed URLs),
and Postgres with **every migration** —
so behaviour that mocks cannot show (Realtime delivery under RLS, real error transport, auth) is exercised.
It never touches the hosted project.

```sh
# prerequisites: Docker daemon, apt postgresql-16-wal2json, Supabase images (pulled from public.ecr.aws)
scripts/live-stack/up.sh                       # Postgres :54330, GoTrue, PostgREST, Realtime, Storage, gateway :54321
set -a; . /tmp/live.env; set +a; . scripts/live-stack/app-env.sh
bun run dev --host 127.0.0.1 --port 4173 --strictPort &   # the app, pointed at the stack
bunx playwright test -c playwright.live.config.ts          # all live specs (fresh users per run)
scripts/live-stack/down.sh
```

Notes

- `realtime-runtime.ipv4.exs` is the image's `runtime.exs` with `:inet6` → `:inet` (kernels without IPv6 cannot bind it).
- Storage runs `storage-api` on a local file backend. On a bare Postgres it needs `USAGE`/table grants on the `storage`
  schema for `anon`/`authenticated`/`service_role` (hosted has them by default); `up.sh` applies them. RLS on
  `storage.objects` stays on with no policies, which is what keeps the ID bucket server-only.
- `global-setup.ts` creates unique users each run, so the suite is re-runnable without resetting the DB.
- `global-setup.ts` pre-approves the two shared members' IDs (online orders need an approved ID); `id-verification.spec.ts`
  creates its own members and goes through the real upload + review.
- Staff/server-side actions in the specs (e.g. a manager moving an order) call the real SQL RPCs as the DB superuser.
- Realtime isolation tests open raw websocket clients with NO client-side filter, so only the database's RLS and
  column privileges decide what each customer receives.
