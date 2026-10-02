# Release checklist (release candidate)

Tick in order. **[needs you]** = requires your accounts/decisions; everything else has been done and has evidence in `CANNAPLUG.md`.

## Gates

- [x] `scripts/verify-release.sh` green (typecheck, lint, unit, real-PostgreSQL, rollback rehearsals, build)
- [x] Live browser suite green (real auth/RLS/Realtime, payments against mock providers)
- [x] Hosted migrations applied and verified (`supabase/tests/verify-hosted.sql` all true; security advisories reviewed)
- [x] Smoke suite passes against the local stack (`scripts/smoke-deployed.mjs`)
- [ ] **[needs you]** Deploy preview/staging with sandbox keys and run `docs/release/staging.md` §B (one real sandbox payment per provider)
- [ ] **[needs you]** `bun scripts/check-compliance-copy.ts --strict` passes — **currently blocks**: 10 compliance claims await client approval + documentary
      evidence (SAHPRA authorisation, company registration, lab-test certificates, bank letter, legal sign-off, live phone number). Fill `compliance/copy-register.json`.

## Configuration **[needs you]**

- [ ] Vercel env vars from `runbook.md` §2 (provider keys, `RESEND_API_KEY`, `GEMINI_API_KEY`, `FIRECRAWL_API_KEY`, `SITE_URL`, `LOVABLE_CRON_SECRET`)
- [ ] GitHub secrets `APP_URL`, `CRON_SECRET`; run _Scheduled jobs → dispatch_ once; then _newsroom-launch-batch_ for the three launch articles
- [ ] Yoco + PayPal webhooks registered (live); Resend domain `updates.cannaplug012.co.za` verified; Supabase Auth SMTP + branded templates; leaked-password protection on
- [ ] Delete the hosted `cannaplug-chat` edge function (replaced by the server function)
- [ ] Decide on the `admin_emails` sign-up trigger (audit finding 12)
- [ ] Run the three DROP statements and record the two ID migrations on hosted if not done (see CANNAPLUG.md, ID verification)

## Go-live

- [ ] Production migrations before code (already applied to the hosted project used so far)
- [ ] Deploy; smoke script against production; place and refund one real low-value order per provider
- [ ] Watch `/admin → Payments`, `notification_events` and the audit log for the first hour

## Remaining non-blocking work (post-launch)

1. Real sandbox/e2e round-trips against Yoco/PayPal/Resend in CI (needs sandbox secrets in GitHub).
2. Admin UI for composing marketing campaigns (`promo_announcement` template and consent-aware queue exist; sending is by SQL/service for now).
3. Map admin/staff panel errors to friendly messages (they currently show server text).
4. Move the legacy `paypal-subscription` edge function (Shopify Admin API subscription page) into the app or retire it.
5. Replace hand-written `types.ts` generation scripts with `supabase gen types` once the CLI is in CI.
6. Lint toolchain advisories (brace-expansion) — dev-only.
7. Per-product low-stock thresholds (currently a fixed 5) and a managers' stock-alert preference.
8. Back-in-stock and digest emails are sent by the hourly job — move to event-driven if hourly lag matters.
9. Playwright live suite in CI nightly (currently on demand: Docker + local stack).
10. PDF user guide screenshots are generated from the live stack; refresh them when the UI changes.
