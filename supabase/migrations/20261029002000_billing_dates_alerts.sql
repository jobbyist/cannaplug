-- 29 Oct 2026: Billing tab, part 2.
--   * Supabase and GoDaddy join the billing accounts; WhatsApp, Email & Push keep their rows.
--   * Billing accounts carry a recurrence rule (every N days, monthly or yearly from an anchor date) so the tab can
--     show the next billing date, and an alert goes into the admin bell a day before any bill is due.
--     Shopify: every 30 days from 30 Oct 2026. Payfast gateway: the 27th of each month. Domain: yearly from 27 Sep 2027.
--   * billing_record_payment gains a provider and currency so PayPal (USD) payments are logged as well as Payfast (ZAR).
--   * A real-time alert in the bell whenever the ID-verification credit balance is below the low-balance threshold.
-- Alerts use the automatic-alert mechanism from 20261028005000 (team_notifications.source_key, _team_alert_sync):
-- they appear over Supabase Realtime and archive themselves when the reason goes away. No personal data is stored.

-- Recurrence ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.billing_accounts
  ADD COLUMN IF NOT EXISTS recur_kind text CHECK (recur_kind IS NULL OR recur_kind IN ('every_days', 'monthly', 'yearly')),
  ADD COLUMN IF NOT EXISTS recur_n integer CHECK (recur_n IS NULL OR recur_n BETWEEN 1 AND 366),
  ADD COLUMN IF NOT EXISTS anchor_date date;
ALTER TABLE public.billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_recur_chk;
ALTER TABLE public.billing_accounts ADD CONSTRAINT billing_accounts_recur_chk CHECK (
  (recur_kind IS NULL AND anchor_date IS NULL)
  OR (recur_kind IS NOT NULL AND anchor_date IS NOT NULL AND (recur_kind <> 'every_days' OR recur_n IS NOT NULL)));

ALTER TABLE public.billing_accounts DROP CONSTRAINT IF EXISTS billing_accounts_payment_kind_check;
ALTER TABLE public.billing_accounts ADD CONSTRAINT billing_accounts_payment_kind_check
  CHECK (payment_kind IN ('link', 'payfast_form', 'manage', 'none'));

-- The next date on or after p_today that the rule lands on. Months and years clamp to the last day of a short month.
CREATE OR REPLACE FUNCTION public.billing_next_due(p_kind text, p_n integer, p_anchor date, p_today date)
RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $fn$
DECLARE
  v_base date;
  v_y integer;
  v_m integer;
  v_d integer := extract(day FROM p_anchor)::integer;
  v_c date;
  v_last integer;
BEGIN
  IF p_kind IS NULL OR p_anchor IS NULL OR p_today IS NULL THEN RETURN NULL; END IF;
  IF p_kind = 'every_days' THEN
    IF p_n IS NULL OR p_n < 1 THEN RETURN NULL; END IF;
    IF p_anchor >= p_today THEN RETURN p_anchor; END IF;
    RETURN p_anchor + ((p_today - p_anchor + p_n - 1) / p_n) * p_n;
  END IF;
  v_base := greatest(p_today, p_anchor);
  v_y := extract(year FROM v_base)::integer;
  IF p_kind = 'monthly' THEN
    v_m := extract(month FROM v_base)::integer;
    LOOP
      v_last := extract(day FROM (make_date(v_y, v_m, 1) + interval '1 month - 1 day'))::integer;
      v_c := make_date(v_y, v_m, least(v_d, v_last));
      EXIT WHEN v_c >= v_base;
      v_m := v_m + 1;
      IF v_m > 12 THEN v_m := 1; v_y := v_y + 1; END IF;
    END LOOP;
    RETURN v_c;
  ELSIF p_kind = 'yearly' THEN
    v_m := extract(month FROM p_anchor)::integer;
    LOOP
      v_last := extract(day FROM (make_date(v_y, v_m, 1) + interval '1 month - 1 day'))::integer;
      v_c := make_date(v_y, v_m, least(v_d, v_last));
      EXIT WHEN v_c >= v_base;
      v_y := v_y + 1;
    END LOOP;
    RETURN v_c;
  END IF;
  RETURN NULL;
END;
$fn$;

-- Alert a day before a bill is due (SAST). One alert per account; archived once the date passes or the account
-- is paused or cancelled.
CREATE OR REPLACE FUNCTION public.billing_due_alerts_refresh()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_due date;
  r public.billing_accounts;
  v_n integer := 0;
BEGIN
  FOR r IN SELECT * FROM public.billing_accounts WHERE recur_kind IS NOT NULL LOOP
    v_due := public.billing_next_due(r.recur_kind, r.recur_n, r.anchor_date, v_today);
    IF public._team_alert_sync(
         'alert:bill-due:' || r.slug,
         CASE WHEN r.status = 'active' AND v_due = v_today + 1 THEN 1 ELSE 0 END,
         'reminder', 'manager',
         left('Bill due tomorrow: ' || r.name, 120),
         left(r.provider || ': ' || COALESCE(NULLIF(r.amount_text, ''), 'payment') || ' is due on '
              || trim(to_char(COALESCE(v_due, v_today), 'FMDD FMMonth YYYY')) || '.', 1000)) THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$fn$;

-- ID-check credits: bell alert whenever the available balance is below the low-balance threshold -------------------
CREATE OR REPLACE FUNCTION public.team_alert_id_credits()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_avail integer;
  v_threshold integer;
  v_cost integer;
BEGIN
  SELECT available INTO v_avail FROM public._id_credit_balance();
  SELECT low_balance_threshold, cost_per_check INTO v_threshold, v_cost FROM public.id_credit_settings WHERE id;
  RETURN public._team_alert_sync(
    'alert:id-credits',
    CASE WHEN v_avail < v_threshold THEN 1 ELSE 0 END,
    'alert', 'budtender',
    'ID verification credits are low',
    greatest(v_avail, 0)::text || ' credits left'
      || CASE WHEN v_cost > 0 THEN ' (about ' || (greatest(v_avail, 0) / v_cost)::text || ' checks)' ELSE '' END
      || '. Top up from the Billing tab or ID Checks.');
END;
$fn$;

CREATE OR REPLACE FUNCTION public._id_credit_alert_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM public.team_alert_id_credits();
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS id_credit_ledger_alert ON public.id_credit_ledger;
CREATE TRIGGER id_credit_ledger_alert AFTER INSERT ON public.id_credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION public._id_credit_alert_trigger();
DROP TRIGGER IF EXISTS id_credit_settings_alert ON public.id_credit_settings;
CREATE TRIGGER id_credit_settings_alert AFTER UPDATE OF low_balance_threshold, cost_per_check ON public.id_credit_settings
  FOR EACH STATEMENT EXECUTE FUNCTION public._id_credit_alert_trigger();

-- Payments with a provider and currency -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_record_payment(
  p_slug text, p_provider text, p_provider_payment_id text, p_status text,
  p_amount_cents integer, p_currency text, p_item_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_acc public.billing_accounts;
  v_id uuid;
BEGIN
  SELECT * INTO v_acc FROM public.billing_accounts WHERE slug = p_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_account_not_found'; END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('payfast', 'paypal') THEN
    RAISE EXCEPTION 'invalid_input: provider must be payfast or paypal';
  END IF;
  IF p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'invalid_input: currency must be a 3-letter code';
  END IF;
  IF p_provider_payment_id IS NULL OR length(p_provider_payment_id) NOT BETWEEN 1 AND 64
     OR p_status IS NULL OR length(p_status) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'invalid_input: payment id and status are required';
  END IF;
  INSERT INTO public.billing_payments (account_id, provider, provider_payment_id, status, amount_cents, currency, item_name)
  VALUES (v_acc.id, p_provider, p_provider_payment_id, p_status, p_amount_cents, p_currency, left(p_item_name, 255))
  ON CONFLICT ON CONSTRAINT billing_payments_event_uq DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;
  PERFORM public._audit(NULL, 'billing_payment_recorded', 'billing_account', v_acc.id,
    jsonb_build_object('slug', v_acc.slug, 'provider', p_provider, 'status', p_status,
                       'amount_cents', p_amount_cents, 'currency', p_currency));
  IF p_status IN ('COMPLETE', 'COMPLETED') THEN
    PERFORM public._billing_notify('staff_billing_payment',
      jsonb_build_object('account', v_acc.name, 'provider', v_acc.provider, 'amount_cents', p_amount_cents,
                         'currency', p_currency, 'at', now()),
      'billing_payment:' || v_id::text, false);
  END IF;
  RETURN jsonb_build_object('recorded', true, 'payment_id', v_id);
END;
$fn$;

-- PayPal subscription events for the Shopify account (called only by the verified PayPal webhook) ---------------------
-- A sale is logged only when its subscription is one we created (admin_api_subscriptions); a refund or reversal only
-- when the original sale is already in the billing history.
CREATE OR REPLACE FUNCTION public.billing_paypal_sale(
  p_event text, p_subscription_id text, p_payment_id text, p_sale_id text, p_amount_cents integer, p_currency text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('COMPLETED', 'REFUNDED', 'REVERSED') THEN
    RAISE EXCEPTION 'invalid_input: unsupported PayPal sale event';
  END IF;
  IF p_event = 'COMPLETED' THEN
    IF NOT EXISTS (SELECT 1 FROM public.admin_api_subscriptions WHERE paypal_subscription_id = p_subscription_id) THEN
      RETURN jsonb_build_object('recorded', false, 'reason', 'unknown_subscription');
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.billing_payments WHERE provider = 'paypal' AND provider_payment_id = p_sale_id) THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'unknown_payment');
  END IF;
  RETURN public.billing_record_payment('shopify-admin-api', 'paypal', p_payment_id, p_event, p_amount_cents,
                                       p_currency, 'Shopify Admin API Integration');
END;
$fn$;

-- p_event: ACTIVATED, CANCELLED, SUSPENDED, EXPIRED or PAYMENT_FAILED. Updates the subscription and tells the developer.
CREATE OR REPLACE FUNCTION public.billing_paypal_subscription_event(
  p_subscription_id text, p_event text, p_event_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_acc public.billing_accounts;
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('ACTIVATED', 'CANCELLED', 'SUSPENDED', 'EXPIRED', 'PAYMENT_FAILED') THEN
    RAISE EXCEPTION 'invalid_input: unsupported PayPal subscription event';
  END IF;
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_input: event id is required';
  END IF;
  UPDATE public.admin_api_subscriptions
     SET status = CASE p_event WHEN 'PAYMENT_FAILED' THEN status WHEN 'ACTIVATED' THEN 'ACTIVE' ELSE p_event END,
         updated_at = now()
   WHERE paypal_subscription_id = p_subscription_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'unknown_subscription');
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE slug = 'shopify-admin-api';
  PERFORM public._audit(NULL, 'billing_paypal_subscription_event', 'billing_account', v_acc.id,
    jsonb_build_object('slug', v_acc.slug, 'event', p_event));
  PERFORM public._billing_notify('staff_billing_change',
    jsonb_build_object('account', v_acc.name, 'provider', v_acc.provider, 'from', 'PayPal subscription',
                       'to', lower(replace(p_event, '_', ' ')), 'reason', 'Reported by PayPal',
                       'actor_name', 'PayPal', 'at', now()),
    'billing_paypal:' || p_event_id, false);
  RETURN jsonb_build_object('recorded', true);
END;
$fn$;

-- Accounts with a Manage button (the domain) are not paid by link either.
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
  IF v_acc.payment_kind IN ('payfast_form', 'manage') THEN
    RAISE EXCEPTION 'invalid_input: this account does not use a payment link';
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

DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.billing_next_due(text, integer, date, date)',
    'public.billing_due_alerts_refresh()',
    'public.team_alert_id_credits()',
    'public._id_credit_alert_trigger()',
    'public.billing_record_payment(text, text, text, text, integer, text, text)',
    'public.billing_paypal_sale(text, text, text, text, integer, text)',
    'public.billing_paypal_subscription_event(text, text, text)',
    'public.billing_set_payment_link(uuid, text, text, text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  -- Refresh the bill-due alerts every 10 minutes where pg_cron exists (not in local test databases).
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('billing-due-alerts', '*/10 * * * *', 'SELECT public.billing_due_alerts_refresh()');
  END IF;
END $do$;

-- Data: new accounts, order, recurrence rules ----------------------------------------------------------------------------
INSERT INTO public.billing_accounts
  (slug, position, name, provider, beneficiary, amount_text, schedule_text, status, payment_kind, payment_url, payment_note,
   recur_kind, recur_n, anchor_date)
VALUES
  ('supabase-platform', 4, 'Database, User Authentication, Storage & Real-Time Notifications', 'Supabase',
   'Supabase (managed by Gravitas)', 'Free plan',
   'Free for now. Paid plans start from $20/month after exceeding free tier limits.', 'active', 'none', NULL, '',
   NULL, NULL, NULL),
  ('godaddy-domain', 8, 'Domain Registration and DNS Management Services', 'GoDaddy',
   'GoDaddy: www.cannaplug012.co.za', 'R163.99 per year',
   'Renews every year. Auto-renews on 27 September 2027.', 'active', 'manage', NULL, '',
   'yearly', NULL, DATE '2027-09-27')
ON CONFLICT (slug) DO NOTHING;

UPDATE public.billing_accounts SET position = 5 WHERE slug = 'whatsapp';
UPDATE public.billing_accounts SET position = 6 WHERE slug = 'payfast-gateway';
UPDATE public.billing_accounts SET position = 7 WHERE slug = 'verifynow-id';
UPDATE public.billing_accounts SET recur_kind = 'every_days', recur_n = 30, anchor_date = DATE '2026-10-30'
 WHERE slug = 'shopify-admin-api' AND recur_kind IS NULL;
UPDATE public.billing_accounts SET recur_kind = 'monthly', recur_n = NULL, anchor_date = DATE '2026-10-27'
 WHERE slug = 'payfast-gateway' AND recur_kind IS NULL;

SELECT public.billing_due_alerts_refresh();
SELECT public.team_alert_id_credits();
