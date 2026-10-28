# Cannaplug release runbook

Audience: whoever deploys and operates the site. Everything here has been rehearsed against the local stack; items that
need your accounts or credentials are marked **[needs you]**.

## 1. Architecture in one minute

- **App**: TanStack Start (SSR + server functions) on Vercel. Browser ⇄ Supabase directly for auth/RLS reads/Realtime; every
  privileged action goes through a server function that re-checks the caller's role, then calls a service-role-only database function.
- **Database**: Supabase Postgres. Money, stock, loyalty and roles are only changed by `SECURITY DEFINER` functions that browsers cannot execute
  (verified by `src/test/db/security-audit.test.ts`).
- **Payments**: PayFast (ZAR) and PayPal (USD). PayFast either opens its own payment window over our checkout (onsite, when `PAYFAST_ONSITE=true`: the server gets a one-time id from PayFast's `/onsite/process`, the page runs PayFast's `engine.js`) or takes a signed form POST to PayFast's page — the same transaction either way. Both settle only through verified notifications (`/api/public/payments/payfast-itn`, `/api/public/payments/paypal-webhook`) → `payments_apply_verified_event`. Bank transfer (EFT) is offered only once a manager saves owner-confirmed bank details in Admin → Payments.
  Manual EFT: manager-only, dual control above R10,000. A payment return URL never marks anything paid.
- **Email/SMS**: DB queue (`notification_events`) drained by `/api/public/notifications/dispatch` (Resend; optional Twilio).
- **AI**: "Ask Cannaplug" (`gemini-2.5-flash`) and the Journal pipeline share one Gemini project; quotas are enforced in the database.

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Group                   | Variables                                                                                                                                                 | Notes                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Supabase                | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | Service role key is server-only.                                                                                                                                                           |
| Cron                    | `LOVABLE_CRON_SECRET` (+ optional `_PREVIOUS` during rotation)                                                                                            | Same value goes in GitHub secret `CRON_SECRET`.                                                                                                                                            |
| Site                    | `SITE_URL`, `VERIFICATION_IP_SALT` (contact-form mail always goes to `admin@cannaplug012.co.za`)                                                          |                                                                                                                                                                                            |
| PayFast                 | `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_ENV` (`live` default, or `sandbox`), `PAYFAST_ONSITE` (`false` default)     | The passphrase must match PayFast → Settings → Developer settings. Merchant ID is compared on every ITN.                                                                                   |
| PayPal                  | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_MERCHANT_ID`, `PAYPAL_ENV`                                                       | `PAYPAL_MERCHANT_ID` is compared on every capture.                                                                                                                                         |
| Email                   | `RESEND_API_KEY`, optional `NOTIFY_FROM_EMAIL`                                                                                                            | Sender `Cannaplug Support <admin@cannaplug012.co.za>`, replies to admin@cannaplug012.co.za; falls back to admin@updates.cannaplug012.co.za until cannaplug012.co.za is verified in Resend. |
| SMS/WhatsApp (optional) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`                                                                      | Also switch on `payment_settings.sms_enabled`.                                                                                                                                             |
| AI                      | `GEMINI_API_KEY`, `FIRECRAWL_API_KEY`, optional `UNSPLASH_ACCESS_KEY`, `GEMINI_RPM_LIMIT` (8), `GEMINI_RPD_LIMIT` (180), `CHAT_RPD_LIMIT` (140)           | The free-tier numbers are shown in Google AI Studio; set the limits just below them.                                                                                                       |
| Push (web)              | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:info@cannaplug012.co.za`)                                                               | Generate with `bun scripts/gen-vapid.ts` once the web-push branch is merged.                                                                                                               |
| AI (member chat)        | optional `GEMINI_CHAT_MODEL` (default `gemini-2.5-flash`), `CHAT_MEMBER_RPD` (default 20)                                                                 | Per-member daily chat messages.                                                                                                                                                            |
| Monitoring              | optional `SENTRY_DSN`                                                                                                                                     | Server-side errors only, scrubbed; off when unset. Uptime checker: `GET /api/public/health`.                                                                                               |
| Clinical                | `SIGNATURE_ATTESTATION_SECRET`, `EXTERNAL_SIGNATURE_API_URL/KEY/WEBHOOK_SECRET`, `DOCUMENT_EMAIL_FROM`, `PUBLIC_APP_URL`                                  | See the clinical section of CANNAPLUG.md.                                                                                                                                                  |

**Supabase Edge Function secrets are NOT readable by the app.** The Resend/Gemini/Firecrawl keys must be added to Vercel; Edge Function secrets
only serve the legacy `paypal-subscription` function.

## 3. Schedulers

**Since 25 Oct 2026 the database runs the jobs** (pg_cron + pg_net, migration `20261025003000_scheduler_fallback`): jobs
`cannaplug-dispatch`, `cannaplug-maintenance`, `cannaplug-newsroom-daily` call the routes below with the bearer stored in
Supabase Vault (`cannaplug_scheduler_secret`, equal to Vercel `LOVABLE_CRON_SECRET_PREVIOUS`) and the URL in
`cannaplug_app_url`. Check runs with `select * from net._http_response order by created desc limit 10;` and
`select * from cron.job_run_details order by start_time desc limit 10;`. Rotate the secret in Vault and Vercel together.

GitHub Actions (`.github/workflows/scheduled-jobs.yml`) is the second scheduler; it is not running while the GitHub
account is locked over billing. Both can run at once: the routes lease or skip work that is not due.

Add repository secrets `APP_URL` and `CRON_SECRET`. Then:

| Cron                                                                                                             | Job                                                                                         | Endpoint                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| every 5 min                                                                                                      | email/SMS queue + stale payment expiry                                                      | `POST /api/public/notifications/dispatch`        |
| hourly (:17)                                                                                                     | stock holds, loyalty retries, clinical expiry, ID retention, email automations, quota purge | `POST /api/public/inventory/maintenance`         |
| 04:00 UTC = **06:00 SAST**                                                                                       | one Journal article (idempotent: skipped if one was published < 18 h ago)                   | `POST /api/public/newsroom/run {"mode":"daily"}` |
| Launch backfill (three articles for today): Actions → _Scheduled jobs_ → Run workflow → `newsroom-launch-batch`. |
| GitHub Actions cron can lag a few minutes under load; every job is idempotent, so lateness is harmless.          |

## 4. Provider setup **[needs you]**

1. **PayFast**: dashboard → Settings → Developer settings: copy Merchant ID and Merchant Key, set a **passphrase** (same value in `PAYFAST_PASSPHRASE`). No webhook to register: each payment carries its own notify URL (`https://<site>/api/public/payments/payfast-itn`). Ask PayFast to confirm the product range is acceptable on the account before going live. **Onsite window (optional):** ask PayFast to enable "Onsite Payments" on the merchant account, then set `PAYFAST_ONSITE=true` and redeploy. It needs HTTPS, takes card, Instant EFT and Masterpass only (no Apple/Google Pay), and uses the member's account email. If PayFast refuses or is down, checkout silently uses PayFast's page instead (logged as `[payments] onsite payment unavailable`). Admin → Payments shows which mode is live and any PayFast configuration problems.
2. **PayPal**: developer dashboard → app → Webhooks: URL `https://<site>/api/public/payments/paypal-webhook`, events
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`; copy the Webhook ID. Merchant ID is under Account settings.
3. **Resend**: verify `updates.cannaplug012.co.za` (SPF/DKIM). Send a test: `RESEND_API_KEY=… bun scripts/send-test-emails.ts you@example.com`.
4. **Supabase Auth emails**: custom SMTP + templates, see `supabase/templates/README.md`.
5. Run **one sandbox payment per provider** end to end before going live (the code is tested against faithful fakes, not the real sandboxes).

## 4b. Dashboard actions still open (23 Oct 2026) **[needs you]**

Database clean-up is done: `supabase/owner-actions/2026-10-hosted-cleanup.sql` is applied and `supabase/tests/verify-cleanup.sql` returns all true.
These need a person in a dashboard:

1. **Supabase → Edge Functions → `cannaplug-chat` → Delete.** It now only answers `410 Gone` behind JWT verification (replaced 23 Oct), so it is harmless until deleted.
2. **Supabase → Authentication → Passwords → enable leaked-password protection.**
3. **Supabase → Authentication → Email templates:** paste `supabase/templates/*.html` (see `supabase/templates/README.md`).
4. **GitHub → Settings → Actions → General:** allow Actions to run, then add repository secrets `APP_URL` (`https://cannaplug012.co.za`) and `CRON_SECRET` (same value as `LOVABLE_CRON_SECRET`). Run _Scheduled jobs → dispatch_ once.
5. **Vercel env vars:** run `bun scripts/check-env.ts .env.production` against a pulled copy, or compare with `docs/release/env-matrix.md`. Yoco variables are gone (removed 23 Oct 2026); delete any `YOCO_*` left in Vercel.

## 5. Deploy

See `staging.md` (staging first) then `release-checklist.md`. Migrations are applied **before** the code that needs them (all migrations are
additive; the code tolerates the old schema for the minutes in between except the payment/checkout path, which needs the M5 tables).

## 6. Operating the system

- **Payments → Needs attention** (admin): `review` = a verified event did not match (amount/currency/merchant/reference) — nothing was applied.
  Check the provider dashboard; if the money is genuine, confirm via the EFT workflow or contact the customer. `needs_refund` = money arrived that
  cannot be applied (cancelled/duplicate) — refund in the provider dashboard.
- **Webhook refusals** (24 h count on the Payments tab): a spike means someone is probing, or the signing secret is wrong after a rotation.
- **FX**: PayPal needs a current ZAR→USD rate. Feeds down → last valid rate; none → PayPal is declined at checkout (PayFast/EFT unaffected). Managers can
  set a manual rate or switch to manual mode in Payments.
- **Notifications**: `notification_events` rows in `dead` status failed permanently (`last_error` says why). Fix the cause, then
  `update notification_events set status='queued', attempts=0, next_attempt_at=now() where id=…`.
- **Chatbot limits**: visitors see friendly messages; counters live in `ai_usage_counters` (purged hourly). Raise `GEMINI_*` only after upgrading the Google tier.
- **Journal paused**: a rejected Gemini key trips `newsroom_job_state.paused_at`. Fix the key, then `update newsroom_job_state set paused_at=null, paused_reason=null where id='daily-article'`.
- **Audit log**: `/admin → Audit log` (manager+). Append-only in the database.
- **Till cash-up (POS)**: record every cash expense paid from the till under **Till expenses** as it happens (category, what for, amount;
  no customer, ID or health details) and give every discount through the till. At close, count all cash, enter the **cash for the bank deposit**;
  the rest is the float for the next session (suggested when that drawer is next opened). Expected cash = opening float + cash taken (after
  discounts) − cash refunds − till expenses; the full reconciliation is shown after the count and stored, unchangeable, on the session. Variances
  over R10 still need a manager (not the cashier) to approve with a reason. Everything appears in **Reports** (PDF, Word, Excel, CSV downloads).
- **PayFast balance and payouts** (Payments tab, manager+): read live from PayFast's Transaction History API with the merchant id and
  `PAYFAST_PASSPHRASE` (no new settings). Shows the balance net of PayFast fees, today's online payments and fees, the automated daily payout
  (pending once the balance reaches R100; completed once PayFast has paid it), and PayFast's fees. Buyer names from PayFast are never stored or
  shown. If it says "unavailable", check the passphrase and that API access is allowed on the PayFast account.
- **Rotating the cron secret**: set `LOVABLE_CRON_SECRET_PREVIOUS` = old, `LOVABLE_CRON_SECRET` = new, update GitHub `CRON_SECRET`, redeploy, then remove `_PREVIOUS`.

## 7. Smoke test

`node scripts/smoke-deployed.mjs https://<site> --cron-secret=…` — pages render, headers present, webhooks and cron endpoints refuse anonymous callers.
