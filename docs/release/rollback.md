# Rollback notes

**Rule 1: roll the code back first (Vercel → Deployments → Promote the previous build, or `request_rollback`). Roll the database back only if the
schema itself is the problem.** Every Milestone 5–6 migration is additive and the previous code ignores the new objects, so a code rollback alone is
safe — with one exception: rolling the code back past Milestone 5 re-opens EFT-only checkout, so orders placed with card/PayPal in the meantime stay
`awaiting_payment` until the payment is reconciled by hand from the provider dashboards.

## Database rollbacks (newest first)
Each migration has a tested rollback in `supabase/rollbacks/`. Rehearsals: `scripts/rollback-rehearsal-m6.sh`, `…-payments.sh`, `…-m5b.sh`, `…-m4.sh`
(run in CI). Run a rollback with `psql -v ON_ERROR_STOP=1 -f supabase/rollbacks/<name>_rollback.sql` against the project, then delete the row from
`supabase_migrations.schema_migrations` so the history matches.

| Migration | Rollback effect | Data warning |
| --- | --- | --- |
| `20261004005000_email_automations` | removes the welcome/ID triggers and `email_automations_run` | none (queued emails stay queued) |
| `20261004004000_audit_hardening` | removes the audit triggers/indexes | audit rows are kept |
| `20261004003000_least_privilege_baseline` | restores the previous over-broad grants (not TRUNCATE/TRIGGER/REFERENCES) | none — only do this if a legitimate client path broke |
| `20261004002000_ai_quota` | drops the counters | none (disposable) |
| `20261004001000_public_forms` | drops contact messages + newsletter subscribers | **export first** — consent records are lost |
| `20261003001000_payments_notifications` | restores EFT-only checkout and the old `transition_order_status`; drops payment/webhook/FX/notification tables | **export first** — loses the provider audit trail; orders already confirmed stay confirmed |
Order matters: roll back in reverse order (the M6 rehearsal does exactly that).

## Re-enabling things you switched off
- PayPal off: remove the `PAYPAL_*` variables (the button disappears). Yoco off: remove `YOCO_*`. EFT always remains.
- Chatbot off: remove `GEMINI_API_KEY` (the widget shows the contact details). Journal pipeline off: disable the `newsroom-daily` schedule.
- Email off: remove `RESEND_API_KEY`; nothing is claimed, so queued mail waits instead of failing.

## If a bad deploy already took payments
1. Do not roll the database back. 2. List recent payments: Payments tab, or `select * from payment_transactions order by created_at desc`.
3. Reconcile against the provider dashboards; use the EFT workflow only for genuine bank transfers. 4. Every order that is `awaiting_payment` with a
`succeeded` provider payment can be confirmed through the manager EFT/approval path with the provider reference as the bank reference.
