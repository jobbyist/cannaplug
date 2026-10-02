# Cannaplug release runbook

Audience: whoever deploys and operates the site. Everything here has been rehearsed against the local stack; items that
need your accounts or credentials are marked **[needs you]**.

## 1. Architecture in one minute

- **App**: TanStack Start (SSR + server functions) on Vercel. Browser ⇄ Supabase directly for auth/RLS reads/Realtime; every
  privileged action goes through a server function that re-checks the caller's role, then calls a service-role-only database function.
- **Database**: Supabase Postgres. Money, stock, loyalty and roles are only changed by `SECURITY DEFINER` functions that browsers cannot execute
  (verified by `src/test/db/security-audit.test.ts`).
- **Payments**: Yoco + PayPal hosted checkouts → signed webhooks (`/api/public/payments/*-webhook`) → `payments_apply_verified_event`.
  Manual EFT: manager-only, dual control above R10,000. A payment return URL never marks anything paid.
- **Email/SMS**: DB queue (`notification_events`) drained by `/api/public/notifications/dispatch` (Resend; optional Twilio).
- **AI**: "Ask Cannaplug" (`gemini-2.5-flash`) and the Journal pipeline share one Gemini project; quotas are enforced in the database.

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Group                   | Variables                                                                                                                                                 | Notes                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Supabase                | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | Service role key is server-only.                                                                 |
| Cron                    | `LOVABLE_CRON_SECRET` (+ optional `_PREVIOUS` during rotation)                                                                                            | Same value goes in GitHub secret `CRON_SECRET`.                                                  |
| Site                    | `SITE_URL`, `CONTACT_INBOX` (default `info@cannaplug012.co.za`), `VERIFICATION_IP_SALT`                                                                   |                                                                                                  |
| Yoco                    | `YOCO_SECRET_KEY` (`sk_test_…`/`sk_live_…`), `YOCO_WEBHOOK_SECRET` (`whsec_…`)                                                                            | Test vs live is read from the key prefix.                                                        |
| PayPal                  | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID`, `PAYPAL_ENV`                                                       | `PAYPAL_MERCHANT_ID` is compared on every capture.                                               |
| Email                   | `RESEND_API_KEY`, optional `NOTIFY_FROM_EMAIL`                                                                                                            | Default sender `Cannaplug Support <updates@cannaplug.co.za>`; domain must be verified in Resend. |
| SMS/WhatsApp (optional) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`                                                                      | Also switch on `payment_settings.sms_enabled`.                                                   |
| AI                      | `GEMINI_API_KEY`, `FIRECRAWL_API_KEY`, optional `UNSPLASH_ACCESS_KEY`, `GEMINI_RPM_LIMIT` (8), `GEMINI_RPD_LIMIT` (180), `CHAT_RPD_LIMIT` (140)           | The free-tier numbers are shown in Google AI Studio; set the limits just below them.             |
| Clinical                | `SIGNATURE_ATTESTATION_SECRET`, `EXTERNAL_SIGNATURE_API_URL/KEY/WEBHOOK_SECRET`, `DOCUMENT_EMAIL_FROM`, `PUBLIC_APP_URL`                                  | See the clinical section of CANNAPLUG.md.                                                        |

**Supabase Edge Function secrets are NOT readable by the app.** The Resend/Gemini/Firecrawl keys must be added to Vercel; Edge Function secrets
only serve the legacy `paypal-subscription` function.

## 3. Schedulers (GitHub Actions: `.github/workflows/scheduled-jobs.yml`)

Add repository secrets `APP_URL` and `CRON_SECRET`. Then:

| Cron                                                                                                             | Job                                                                                         | Endpoint                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| every 5 min                                                                                                      | email/SMS queue + stale payment expiry                                                      | `POST /api/public/notifications/dispatch`        |
| hourly (:17)                                                                                                     | stock holds, loyalty retries, clinical expiry, ID retention, email automations, quota purge | `POST /api/public/inventory/maintenance`         |
| 04:00 UTC = **06:00 SAST**                                                                                       | one Journal article (idempotent: skipped if one was published < 18 h ago)                   | `POST /api/public/newsroom/run {"mode":"daily"}` |
| Launch backfill (three articles for today): Actions → _Scheduled jobs_ → Run workflow → `newsroom-launch-batch`. |
| GitHub Actions cron can lag a few minutes under load; every job is idempotent, so lateness is harmless.          |

## 4. Provider setup **[needs you]**

1. **Yoco**: dashboard → Developers → Webhooks: URL `https://<site>/api/public/payments/yoco-webhook`; copy the `whsec_…` secret.
2. **PayPal**: developer dashboard → app → Webhooks: URL `https://<site>/api/public/payments/paypal-webhook`, events
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`; copy the Webhook ID. Merchant ID is under Account settings.
3. **Resend**: verify `cannaplug.co.za` (SPF/DKIM). Send a test: `RESEND_API_KEY=… bun scripts/send-test-emails.ts you@example.com`.
4. **Supabase Auth emails**: custom SMTP + templates, see `supabase/templates/README.md`.
5. Run **one sandbox payment per provider** end to end before going live (the code is tested against faithful fakes, not the real sandboxes).

## 5. Deploy

See `staging.md` (staging first) then `release-checklist.md`. Migrations are applied **before** the code that needs them (all migrations are
additive; the code tolerates the old schema for the minutes in between except the payment/checkout path, which needs the M5 tables).

## 6. Operating the system

- **Payments → Needs attention** (admin): `review` = a verified event did not match (amount/currency/merchant/reference) — nothing was applied.
  Check the provider dashboard; if the money is genuine, confirm via the EFT workflow or contact the customer. `needs_refund` = money arrived that
  cannot be applied (cancelled/duplicate) — refund in the provider dashboard.
- **Webhook refusals** (24 h count on the Payments tab): a spike means someone is probing, or the signing secret is wrong after a rotation.
- **FX**: PayPal needs a current ZAR→USD rate. Feeds down → last valid rate; none → PayPal is hidden at checkout (Yoco/EFT unaffected). Managers can
  set a manual rate or switch to manual mode in Payments.
- **Notifications**: `notification_events` rows in `dead` status failed permanently (`last_error` says why). Fix the cause, then
  `update notification_events set status='queued', attempts=0, next_attempt_at=now() where id=…`.
- **Chatbot limits**: visitors see friendly messages; counters live in `ai_usage_counters` (purged hourly). Raise `GEMINI_*` only after upgrading the Google tier.
- **Journal paused**: a rejected Gemini key trips `newsroom_job_state.paused_at`. Fix the key, then `update newsroom_job_state set paused_at=null, paused_reason=null where id='daily-article'`.
- **Audit log**: `/admin → Audit log` (manager+). Append-only in the database.
- **Rotating the cron secret**: set `LOVABLE_CRON_SECRET_PREVIOUS` = old, `LOVABLE_CRON_SECRET` = new, update GitHub `CRON_SECRET`, redeploy, then remove `_PREVIOUS`.

## 7. Smoke test

`node scripts/smoke-deployed.mjs https://<site> --cron-secret=…` — pages render, headers present, webhooks and cron endpoints refuse anonymous callers.
