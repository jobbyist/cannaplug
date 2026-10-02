# Staging deployment and migration verification

## A. Prove the migrations locally (no accounts needed)

```sh
scripts/verify-release.sh          # typecheck, lint, unit, real-PostgreSQL tests, rollback rehearsals, build, audit
```

`bun run test:db` boots a disposable PostgreSQL 16, applies **every** migration in `supabase/migrations/`, and runs the suites against it.
`src/test/migrations.test.ts` additionally proves `drizzle/migrations/` is a byte-identical, in-order mirror.

## B. Staging environment **[needs you]**

1. Create a second Supabase project (or a branch) for staging. Apply migrations: `supabase db push` (or the dashboard SQL editor, in file order).
   The connector in this repository's tooling can apply them too; **DROP statements need to be run by a human** (none exist in M5–M6).
2. Verify the result with `supabase/tests/verify-hosted.sql` (below) — it checks tables, RLS, grants and function exposure on the _hosted_ database.
3. Create a Vercel preview/staging project pointing at the staging Supabase; set the variables from `runbook.md` using **sandbox/test** provider keys
   (`sk_test_…`, `PAYPAL_ENV=sandbox`).
4. Register the staging webhook URLs with Yoco/PayPal sandboxes; add the staging URL to Supabase Auth → URL configuration.
5. `node scripts/smoke-deployed.mjs https://<staging> --cron-secret=…`
6. Manual critical path (15 min): sign up → upload ID → approve in /admin → add to cart → pay with EFT (confirm as manager) → pay with Yoco sandbox card
   → pay with PayPal sandbox → refresh /account (status live) → POS cash/card/EFT sale → contact form → newsletter → Ask Cannaplug.
7. Trigger the schedulers once (`workflow_dispatch`) and confirm `notification_events` drain and an email arrives.

## C. Promote

Apply the same migrations to production **before** merging/deploying the code; run `verify-hosted.sql`; deploy; run the smoke script; do the manual
critical path with a R1-ish product in live mode and refund it.
