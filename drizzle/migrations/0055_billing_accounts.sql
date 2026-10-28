-- 29 Oct 2026: recurring billing accounts for the admin Billing tab.
--   * billing_accounts: the fixed recurring costs Cannaplug pays to service providers (Shopify, Payfast, VerifyNow,
--     Meta, Resend/Supabase, clinical documents), seeded from the billing schedule. Admins and managers read it.
--   * billing_set_status: managers and admins pause, cancel or resume an account. Cannaplug cannot stop a
--     provider's subscription itself, so every change is audited and emails the developer to action it.
--   * billing_set_payment_link: admins only; sets the payment link for an account (https, known hosts).
--   * billing_payments / billing_record_payment: payments confirmed by a verified Payfast notification; the
--     function is idempotent per Payfast payment id and status, and emails the developer when one completes.
-- Every write goes through the service-role-only functions below (actor argument, idempotency key, audit).
-- No ID, health or customer data is stored here or put in the emails.

CREATE TABLE IF NOT EXISTS public.billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  position integer NOT NULL DEFAULT 0,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  provider text NOT NULL CHECK (length(btrim(provider)) BETWEEN 2 AND 80),
  beneficiary text NOT NULL DEFAULT '' CHECK (length(beneficiary) <= 160),
  amount_text text NOT NULL DEFAULT '' CHECK (length(amount_text) <= 120),
  schedule_text text NOT NULL DEFAULT '' CHECK (length(schedule_text) <= 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'pending')),
  payment_kind text NOT NULL DEFAULT 'none' CHECK (payment_kind IN ('link', 'payfast_form', 'none')),
  payment_url text CHECK (payment_url IS NULL OR (payment_url ~ '^https://' AND length(payment_url) <= 500)),
  payment_note text NOT NULL DEFAULT '' CHECK (length(payment_note) <= 160),
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 300),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.billing_accounts(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'payfast' CHECK (provider IN ('payfast', 'paypal')),
  provider_payment_id text NOT NULL CHECK (length(provider_payment_id) BETWEEN 1 AND 64),
  status text NOT NULL CHECK (length(status) BETWEEN 1 AND 40),
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency text NOT NULL DEFAULT 'ZAR',
  item_name text CHECK (item_name IS NULL OR length(item_name) <= 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_payments_event_uq UNIQUE (provider, provider_payment_id, status)
);
CREATE INDEX IF NOT EXISTS billing_payments_account_idx ON public.billing_payments (account_id, created_at DESC);

ALTER TABLE public.billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_accounts, public.billing_payments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_accounts, public.billing_payments TO authenticated;
GRANT ALL ON public.billing_accounts, public.billing_payments TO service_role;

CREATE POLICY "managers read billing accounts" ON public.billing_accounts FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)));
CREATE POLICY "managers read billing payments" ON public.billing_payments FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)));

-- Developer notices: who is told when a status changes, and who when a payment completes.
CREATE OR REPLACE FUNCTION public._billing_notify(p_template text, p_data jsonb, p_dedupe text, p_status_change boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_to text;
BEGIN
  FOREACH v_to IN ARRAY (CASE WHEN p_status_change
    THEN ARRAY['webmaster@cannaplug012.co.za', 'primelifer@gmail.com']
    ELSE ARRAY['webmaster@cannaplug012.co.za'] END)
  LOOP
    PERFORM public.notification_enqueue('email', p_template, v_to, NULL, 'staff', p_data, p_dedupe || ':' || v_to);
  END LOOP;
END;
$fn$;

-- p_status: 'active' (resume), 'paused' or 'cancelled'. Pending accounts are not changed here.
CREATE OR REPLACE FUNCTION public.billing_set_status(
  p_actor uuid, p_slug text, p_status text, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_cached jsonb;
  v_response jsonb;
  v_acc public.billing_accounts;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_name text;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('billing_status', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_slug, 'to', p_status, 'r', v_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_status IS NULL OR p_status NOT IN ('active', 'paused', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_input: status must be active, paused or cancelled';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 300 THEN
    RAISE EXCEPTION 'invalid_input: the reason is too long (300 characters at most)';
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE slug = p_slug FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_account_not_found'; END IF;
  IF v_acc.status = 'pending' THEN
    RAISE EXCEPTION 'invalid_input: this account is pending activation and cannot be changed yet';
  END IF;
  IF v_acc.status = p_status THEN
    v_response := jsonb_build_object('changed', false, 'status', v_acc.status);
    RETURN public._idem_finish('billing_status', p_actor, p_idempotency_key, v_response);
  END IF;

  UPDATE public.billing_accounts
     SET status = p_status, status_reason = v_reason, updated_by = p_actor, updated_at = now()
   WHERE id = v_acc.id;
  PERFORM public._audit(p_actor, 'billing_status_changed', 'billing_account', v_acc.id,
    jsonb_build_object('slug', v_acc.slug, 'from', v_acc.status, 'to', p_status, 'reason', v_reason));

  SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), 'A staff member') INTO v_name
  FROM (SELECT 1) x LEFT JOIN public.profiles pr ON pr.id = p_actor;
  PERFORM public._billing_notify('staff_billing_change',
    jsonb_build_object('account', v_acc.name, 'provider', v_acc.provider, 'from', v_acc.status, 'to', p_status,
                       'reason', v_reason, 'actor_name', COALESCE(v_name, 'A staff member'), 'at', now()),
    'billing_status:' || v_acc.id::text || ':' || p_actor::text || ':' || p_idempotency_key, true);

  v_response := jsonb_build_object('changed', true, 'status', p_status, 'previous', v_acc.status);
  RETURN public._idem_finish('billing_status', p_actor, p_idempotency_key, v_response);
END;
$fn$;

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

-- Called only by the verified Payfast notify handler. Idempotent per (provider payment id, status).
CREATE OR REPLACE FUNCTION public.billing_record_payment(
  p_slug text, p_provider_payment_id text, p_status text, p_amount_cents integer, p_item_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_acc public.billing_accounts;
  v_id uuid;
BEGIN
  SELECT * INTO v_acc FROM public.billing_accounts WHERE slug = p_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_account_not_found'; END IF;
  IF p_provider_payment_id IS NULL OR length(p_provider_payment_id) NOT BETWEEN 1 AND 64
     OR p_status IS NULL OR length(p_status) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'invalid_input: payment id and status are required';
  END IF;
  INSERT INTO public.billing_payments (account_id, provider_payment_id, status, amount_cents, item_name)
  VALUES (v_acc.id, p_provider_payment_id, p_status, p_amount_cents, left(p_item_name, 255))
  ON CONFLICT ON CONSTRAINT billing_payments_event_uq DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('recorded', false);
  END IF;
  PERFORM public._audit(NULL, 'billing_payment_recorded', 'billing_account', v_acc.id,
    jsonb_build_object('slug', v_acc.slug, 'status', p_status, 'amount_cents', p_amount_cents));
  IF p_status = 'COMPLETE' THEN
    PERFORM public._billing_notify('staff_billing_payment',
      jsonb_build_object('account', v_acc.name, 'provider', v_acc.provider, 'amount_cents', p_amount_cents, 'at', now()),
      'billing_payment:' || v_id::text, false);
  END IF;
  RETURN jsonb_build_object('recorded', true, 'payment_id', v_id);
END;
$fn$;

DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._billing_notify(text, jsonb, text, boolean)',
    'public.billing_set_status(uuid, text, text, text, text)',
    'public.billing_set_payment_link(uuid, text, text, text)',
    'public.billing_record_payment(text, text, text, integer, text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $do$;

-- Seed: the recurring billing schedule (the schedule has no row 6).
INSERT INTO public.billing_accounts
  (slug, position, name, provider, beneficiary, amount_text, schedule_text, status, payment_kind, payment_url, payment_note)
VALUES
  ('shopify-admin-api', 1, 'Admin/Checkout API Integration (POS + E-Commerce)', 'Shopify', 'Shopify Developers (managed by Gravitas)',
   '$28.75 (approx. R470.00)', 'Oct 30, Nov 29, Dec 29, Jan 28, Feb 27, Mar 29', 'active', 'link',
   'https://cannaplug012.co.za/subscribe/admin-api', ''),
  ('clinical-documents', 2, 'Clinical Document System for Doctor''s Letter', 'Clinical documents', 'N/A',
   'Inactive', 'Pending activation', 'pending', 'none', NULL, ''),
  ('email-push', 3, 'Email & Push Notification Engine', 'Resend & Supabase', 'Resend & Supabase (managed by Gravitas)',
   'FREE for 100 emails p/day + 3000 emails p/m', 'N/A', 'active', 'none', NULL, ''),
  ('whatsapp', 4, 'WhatsApp Notification Engine', 'Meta Cloud Services', 'Meta Cloud Services (managed by Gravitas)',
   'R125.00 p/m for 500 messages', 'Pending activation', 'pending', 'none', NULL, 'Stripe or PayPal (coming soon)'),
  ('payfast-gateway', 5, 'Online Payment Gateway Aggregator', 'Payfast', 'Payfast by Network (managed by Gravitas)',
   'R180.00', '27th of every month', 'active', 'link', 'https://payf.st/rl53i', ''),
  ('verifynow-id', 7, 'ID Verification System', 'VerifyNow', 'VerifyNow (managed by Gravitas)',
   'R3 per credit', 'As needed', 'active', 'payfast_form', NULL, '')
ON CONFLICT (slug) DO NOTHING;
