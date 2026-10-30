-- 31 Oct 2026: record a bill that was paid outside the billing system (bank transfer, a card paid directly with the
-- provider, cash to the developer). Until now only Payfast and PayPal webhooks could add billing history, so a bill paid
-- any other way still looked unpaid in /admin → Billing.
--   * billing_payments.provider may now also be 'manual'.
--   * billing_record_manual_payment: admins only, idempotent, audited with the acting admin, dated to the day it was
--     paid (today or up to 90 days back, SAST), always 'COMPLETE'. It notifies the developer exactly like a provider
--     payment. Like any completed payment it lifts an active commerce suspension for that account (the existing
--     commerce_resume_on_payment trigger), which is the right outcome: the bill is paid.
-- No customer, health or ID data is stored. No DELETE in this file; the provider check is replaced to widen it.

ALTER TABLE public.billing_payments DROP CONSTRAINT IF EXISTS billing_payments_provider_check;
ALTER TABLE public.billing_payments
  ADD CONSTRAINT billing_payments_provider_check CHECK (provider IN ('payfast', 'paypal', 'manual'));

CREATE OR REPLACE FUNCTION public.billing_record_manual_payment(
  p_actor uuid, p_slug text, p_amount_cents integer, p_currency text, p_paid_on date, p_note text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_acc public.billing_accounts;
  v_cached jsonb;
  v_id uuid;
  v_today date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_note text := btrim(COALESCE(p_note, ''));
  v_at timestamptz;
  v_response jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin');
  SELECT * INTO v_acc FROM public.billing_accounts WHERE slug = p_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_account_not_found'; END IF;
  IF p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 100000000 THEN
    RAISE EXCEPTION 'invalid_input: enter the amount that was paid';
  END IF;
  IF p_currency IS NULL OR p_currency NOT IN ('ZAR', 'USD') THEN
    RAISE EXCEPTION 'invalid_input: currency must be ZAR or USD';
  END IF;
  IF p_paid_on IS NULL OR p_paid_on > v_today OR p_paid_on < v_today - 90 THEN
    RAISE EXCEPTION 'invalid_input: the payment date must be today or within the last 90 days';
  END IF;
  IF length(v_note) NOT BETWEEN 3 AND 200 THEN
    RAISE EXCEPTION 'invalid_input: add a short note on how it was paid (3 to 200 characters)';
  END IF;

  v_cached := public._idem_begin('billing_record_manual_payment', p_actor, p_idempotency_key,
    jsonb_build_object('slug', p_slug, 'amount', p_amount_cents, 'currency', p_currency,
                       'paid_on', p_paid_on, 'note', v_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  -- Dated to the day it was paid: now for today, otherwise midday SAST on that day.
  v_at := CASE WHEN p_paid_on = v_today THEN now()
               ELSE (p_paid_on + time '12:00') AT TIME ZONE 'Africa/Johannesburg' END;
  INSERT INTO public.billing_payments
    (account_id, provider, provider_payment_id, status, amount_cents, currency, item_name, created_at)
  VALUES (v_acc.id, 'manual', 'manual-' || left(md5(p_actor::text || ':' || p_idempotency_key), 24), 'COMPLETE',
          p_amount_cents, p_currency, left('Manual payment: ' || v_note, 255), v_at)
  RETURNING id INTO v_id;

  PERFORM public._audit(p_actor, 'billing_payment_recorded_manual', 'billing_account', v_acc.id,
    jsonb_build_object('slug', v_acc.slug, 'amount_cents', p_amount_cents, 'currency', p_currency,
                       'paid_on', p_paid_on, 'note', v_note, 'billing_payment_id', v_id));
  PERFORM public._billing_notify('staff_billing_payment',
    jsonb_build_object('account', v_acc.name, 'provider', v_acc.provider, 'amount_cents', p_amount_cents,
                       'currency', p_currency, 'at', v_at),
    'billing_payment:' || v_id::text, false);
  v_response := jsonb_build_object('recorded', true, 'payment_id', v_id);
  RETURN public._idem_finish('billing_record_manual_payment', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.billing_record_manual_payment(uuid, text, integer, text, date, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_record_manual_payment(uuid, text, integer, text, date, text, text)
  TO service_role;
