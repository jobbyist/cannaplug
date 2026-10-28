-- Rollback for 20261029001000_billing_accounts: removes the billing tables and functions. Refused once a Payfast
-- payment has been recorded or a status/link has been changed, since that history would be lost.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.billing_payments) THEN
    RAISE EXCEPTION 'rollback_blocked: billing payments are recorded; keep this migration or export them first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_accounts WHERE updated_by IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback_blocked: staff have changed billing accounts; keep this migration or export them first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.billing_record_payment(text, text, text, integer, text);
DROP FUNCTION IF EXISTS public.billing_set_payment_link(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.billing_set_status(uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public._billing_notify(text, jsonb, text, boolean);
DROP TABLE IF EXISTS public.billing_payments;
DROP TABLE IF EXISTS public.billing_accounts;
