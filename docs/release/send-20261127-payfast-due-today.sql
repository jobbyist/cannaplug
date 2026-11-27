-- Cannaplug: one-off "Bill due today" email for the Payfast gateway bill (R180.00, due Fri 27 Nov 2026).
-- Run ONLY after the staff_billing_due email template is deployed (the merged PR), otherwise the dispatcher cannot render it.
-- It queues one email per manager/admin; the dedupe key makes a second run send nothing. No migration is needed for this step.
SELECT public.notification_enqueue_staff(
  'staff_billing_due',
  jsonb_build_object(
    'due_in_days', 0,
    'account', 'Online Payment Gateway Aggregator',
    'provider', 'Payfast',
    'amount_text', 'R180.00',
    'due_on', 'Friday, 27 November 2026',
    'next_account', 'Admin/Checkout API Integration (POS + E-Commerce)',
    'next_provider', 'Shopify',
    'next_amount_text', '$28.75 incl. 15% sales tax ($25.00 excl.), approx. R470.00',
    'next_due_on', 'Sunday, 29 November 2026'),
  'billing_due:payfast-gateway:2026-11-27:today',
  'manager'::public.app_role) AS emails_queued;
