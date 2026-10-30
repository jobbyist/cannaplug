-- Rollback for 20261031003000_billing_manual_payment: removes the manual-payment function and narrows the provider
-- check back to Payfast and PayPal. Refused while manual payments are recorded (they are real billing history); remove
-- or reclassify them first if you really must roll back.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.billing_payments WHERE provider = 'manual') THEN
    RAISE EXCEPTION 'manual billing payments exist: they are billing history, keep them or remove them first';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.billing_record_manual_payment(uuid, text, integer, text, date, text, text);
ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_provider_check;
ALTER TABLE public.billing_payments
  ADD CONSTRAINT billing_payments_provider_check CHECK (provider IN ('payfast', 'paypal'));
