-- Rollback for 20261029002000_billing_dates_alerts: removes the recurrence columns, the due-date and ID-credit alerts and
-- their triggers, the provider/currency payment function, and the Supabase and GoDaddy accounts. Refused once a PayPal
-- payment or a payment for the new accounts is recorded, since that history would be lost.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.billing_payments p
    WHERE p.provider <> 'payfast' OR p.currency <> 'ZAR'
       OR p.account_id IN (SELECT id FROM public.billing_accounts WHERE slug IN ('supabase-platform', 'godaddy-domain'))) THEN
    RAISE EXCEPTION 'rollback_blocked: PayPal or new-account payments are recorded; keep this migration or export them first';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'billing-due-alerts'$q$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS id_credit_ledger_alert ON public.id_credit_ledger;
DROP TRIGGER IF EXISTS id_credit_settings_alert ON public.id_credit_settings;
DROP FUNCTION IF EXISTS public._id_credit_alert_trigger();
DROP FUNCTION IF EXISTS public.team_alert_id_credits();
DROP FUNCTION IF EXISTS public.billing_due_alerts_refresh();
DROP FUNCTION IF EXISTS public.billing_paypal_subscription_event(text, text, text);
DROP FUNCTION IF EXISTS public.billing_paypal_sale(text, text, text, text, integer, text);
DROP FUNCTION IF EXISTS public.billing_record_payment(text, text, text, text, integer, text, text);
DROP FUNCTION IF EXISTS public.billing_next_due(text, integer, date, date);

-- The automatic alerts these functions created (the guard only lets the sync function change them).
SELECT set_config('cannaplug.alert_sync', 'on', true);
DELETE FROM public.team_notification_reads WHERE notification_id IN
  (SELECT id FROM public.team_notifications WHERE source_key = 'alert:id-credits' OR source_key LIKE 'alert:bill-due:%');
DELETE FROM public.team_notifications WHERE source_key = 'alert:id-credits' OR source_key LIKE 'alert:bill-due:%';

DELETE FROM public.billing_accounts WHERE slug IN ('supabase-platform', 'godaddy-domain');
UPDATE public.billing_accounts SET position = 4 WHERE slug = 'whatsapp';
UPDATE public.billing_accounts SET position = 5 WHERE slug = 'payfast-gateway';
UPDATE public.billing_accounts SET position = 7 WHERE slug = 'verifynow-id';

ALTER TABLE public.billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_recur_chk;
ALTER TABLE public.billing_accounts DROP COLUMN IF EXISTS recur_kind, DROP COLUMN IF EXISTS recur_n, DROP COLUMN IF EXISTS anchor_date;
ALTER TABLE public.billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_payment_kind_check;
ALTER TABLE public.billing_accounts ADD CONSTRAINT billing_accounts_payment_kind_check
  CHECK (payment_kind IN ('link', 'payfast_form', 'none'));

-- Admins only. https links on known payment hosts; null clears the link.
CREATE OR REPLACE FUNCTION public.billing_set_payment_link(
  p_actor uuid, p_slug text, p_url text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_cached jsonb;
  v_response jsonb;
  v_acc public.billing_accounts;
  v_url text := NULLIF(btrim(COALESCE(p_url, '')), '');
  v_host text;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin');
  v_cached := public._idem_begin('billing_link', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_slug, 'u', v_url));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF v_url IS NOT NULL THEN
    IF v_url !~ '^https://[a-z0-9.-]+(/[A-Za-z0-9._~:/?#@!$&''()*+,;=%-]*)?$' OR length(v_url) > 500 THEN
      RAISE EXCEPTION 'invalid_input: enter a full https link';
    END IF;
    v_host := lower(substring(v_url FROM '^https://([a-z0-9.-]+)'));
    IF v_host NOT IN ('payf.st', 'payfast.io', 'payment.payfast.io', 'www.payfast.co.za', 'paypal.com',
                      'www.paypal.com', 'paypal.me', 'www.paypal.me', 'cannaplug012.co.za', 'www.cannaplug012.co.za') THEN
      RAISE EXCEPTION 'invalid_input: payment links must be Payfast, PayPal or Cannaplug links';
    END IF;
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE slug = p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_account_not_found'; END IF;
  IF v_acc.payment_kind = 'payfast_form' THEN
    RAISE EXCEPTION 'invalid_input: this account pays through its Payfast button, not a link';
  END IF;

  UPDATE public.billing_accounts
     SET payment_url = v_url, payment_kind = CASE WHEN v_url IS NULL THEN 'none' ELSE 'link' END,
         updated_by = p_actor, updated_at = now()
   WHERE id = v_acc.id;
  PERFORM public._audit(p_actor, 'billing_link_changed', 'billing_account', v_acc.id,
    jsonb_build_object('slug', v_acc.slug, 'had_link', v_acc.payment_url IS NOT NULL, 'has_link', v_url IS NOT NULL));
  v_response := jsonb_build_object('changed', true, 'has_link', v_url IS NOT NULL);
  RETURN public._idem_finish('billing_link', p_actor, p_idempotency_key, v_response);
END;
$fn$;

REVOKE ALL ON FUNCTION public.billing_set_payment_link(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_set_payment_link(uuid, text, text, text) TO service_role;
