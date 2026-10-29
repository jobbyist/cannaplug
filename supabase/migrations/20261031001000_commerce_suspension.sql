-- 31 Oct 2026: temporary suspension of POS sales and online checkout while the Shopify Admin/Checkout API bill is unpaid.
--   * commerce_suspensions: at most one ACTIVE row (resumed_at IS NULL). While it exists the server refuses new POS sales
--     and new online orders/payments. Browser roles can read nothing; every write goes through the functions below.
--   * A completed payment on the linked billing account (PayPal subscription sale or Payfast, both recorded by
--     billing_record_payment) lifts the suspension automatically, in the same transaction as the payment row.
--   * commerce_suspend / commerce_resume: admin only, idempotent, audited. Resume is the manual override if the bill is
--     settled in a way the webhooks cannot see.
--   * The suspension is started here, tied to 'shopify-admin-api'. Payments recorded before this migration do not lift it.
-- Refunds and voids are NOT blocked (money already taken must stay reversible). No health, ID or customer data is stored.

CREATE TABLE IF NOT EXISTS public.commerce_suspensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id uuid REFERENCES public.billing_accounts(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  suspended_at timestamptz NOT NULL DEFAULT now(),
  suspended_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resumed_at timestamptz,
  resumed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resumed_via text CHECK (resumed_via IS NULL OR resumed_via IN ('payment', 'manual')),
  resumed_payment_id uuid REFERENCES public.billing_payments(id) ON DELETE SET NULL,
  CONSTRAINT commerce_suspensions_resumed_ck CHECK ((resumed_at IS NULL) = (resumed_via IS NULL))
);
-- Only one suspension can be active at a time.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_suspensions_one_active
  ON public.commerce_suspensions ((true)) WHERE resumed_at IS NULL;

ALTER TABLE public.commerce_suspensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_suspensions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.commerce_suspensions TO authenticated;
GRANT ALL ON public.commerce_suspensions TO service_role;
DROP POLICY IF EXISTS "managers read commerce suspensions" ON public.commerce_suspensions;
CREATE POLICY "managers read commerce suspensions" ON public.commerce_suspensions FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)));

-- The current suspension, or {"suspended": false}. Read by the server before a sale or an order.
CREATE OR REPLACE FUNCTION public.commerce_suspension_status()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT COALESCE(
    (SELECT jsonb_build_object('suspended', true, 'since', s.suspended_at, 'billing_slug', a.slug)
       FROM public.commerce_suspensions s
       LEFT JOIN public.billing_accounts a ON a.id = s.billing_account_id
      WHERE s.resumed_at IS NULL),
    jsonb_build_object('suspended', false));
$fn$;

CREATE OR REPLACE FUNCTION public.commerce_suspend(p_actor uuid, p_slug text, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_cached jsonb;
  v_response jsonb;
  v_acc public.billing_accounts;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_id uuid;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin');
  v_cached := public._idem_begin('commerce_suspend', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_slug, 'r', v_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'invalid_input: a reason of 3 to 300 characters is required';
  END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE slug = p_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_account_not_found'; END IF;

  INSERT INTO public.commerce_suspensions (billing_account_id, reason, suspended_by)
  VALUES (v_acc.id, v_reason, p_actor)
  ON CONFLICT ((true)) WHERE resumed_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    v_response := jsonb_build_object('changed', false, 'suspended', true);
    RETURN public._idem_finish('commerce_suspend', p_actor, p_idempotency_key, v_response);
  END IF;
  PERFORM public._audit(p_actor, 'commerce_suspended', 'billing_account', v_acc.id,
    jsonb_build_object('slug', v_acc.slug, 'reason', v_reason));
  v_response := jsonb_build_object('changed', true, 'suspended', true, 'id', v_id);
  RETURN public._idem_finish('commerce_suspend', p_actor, p_idempotency_key, v_response);
END;
$fn$;

-- Manual override. The automatic resume is the trigger below.
CREATE OR REPLACE FUNCTION public.commerce_resume(p_actor uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_cached jsonb;
  v_response jsonb;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_row public.commerce_suspensions;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin');
  v_cached := public._idem_begin('commerce_resume', p_actor, p_idempotency_key, jsonb_build_object('r', v_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'invalid_input: a reason of 3 to 300 characters is required';
  END IF;
  UPDATE public.commerce_suspensions
     SET resumed_at = now(), resumed_by = p_actor, resumed_via = 'manual'
   WHERE resumed_at IS NULL
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    v_response := jsonb_build_object('changed', false, 'suspended', false);
    RETURN public._idem_finish('commerce_resume', p_actor, p_idempotency_key, v_response);
  END IF;
  PERFORM public._audit(p_actor, 'commerce_resumed', 'billing_account', v_row.billing_account_id,
    jsonb_build_object('via', 'manual', 'reason', v_reason));
  v_response := jsonb_build_object('changed', true, 'suspended', false);
  RETURN public._idem_finish('commerce_resume', p_actor, p_idempotency_key, v_response);
END;
$fn$;

-- Automatic resume: a completed payment on the linked billing account lifts the suspension.
CREATE OR REPLACE FUNCTION public._commerce_resume_on_payment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_row public.commerce_suspensions;
  v_acc public.billing_accounts;
BEGIN
  UPDATE public.commerce_suspensions
     SET resumed_at = now(), resumed_via = 'payment', resumed_payment_id = NEW.id
   WHERE resumed_at IS NULL AND billing_account_id = NEW.account_id
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO v_acc FROM public.billing_accounts WHERE id = NEW.account_id;
  PERFORM public._audit(NULL, 'commerce_resumed', 'billing_account', NEW.account_id,
    jsonb_build_object('via', 'payment', 'slug', v_acc.slug, 'billing_payment_id', NEW.id));
  PERFORM public._billing_notify('staff_billing_change',
    jsonb_build_object('account', v_acc.name, 'provider', v_acc.provider, 'from', 'POS and online checkout suspended',
                       'to', 'POS and online checkout resumed', 'reason', 'Bill paid',
                       'actor_name', 'Payment received', 'at', now()),
    'commerce_resumed:' || v_row.id::text, false);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS commerce_resume_on_payment ON public.billing_payments;
CREATE TRIGGER commerce_resume_on_payment
  AFTER INSERT ON public.billing_payments
  FOR EACH ROW WHEN (NEW.status IN ('COMPLETE', 'COMPLETED'))
  EXECUTE FUNCTION public._commerce_resume_on_payment();

DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.commerce_suspension_status()',
    'public.commerce_suspend(uuid, text, text, text)',
    'public.commerce_resume(uuid, text, text)',
    'public._commerce_resume_on_payment()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $do$;

-- Start the suspension now, tied to the Shopify Admin/Checkout API bill (due 30 Oct 2026). One-time: it never inserts
-- when the table already has history, so re-running after the bill is paid does not suspend again.
WITH ins AS (
  INSERT INTO public.commerce_suspensions (billing_account_id, reason)
  SELECT a.id, 'Shopify Admin/Checkout API bill unpaid; resumes automatically when the payment is received'
    FROM public.billing_accounts a
   WHERE a.slug = 'shopify-admin-api' AND NOT EXISTS (SELECT 1 FROM public.commerce_suspensions)
  ON CONFLICT ((true)) WHERE resumed_at IS NULL DO NOTHING
  RETURNING billing_account_id
)
SELECT public._audit(NULL, 'commerce_suspended', 'billing_account', billing_account_id,
  jsonb_build_object('slug', 'shopify-admin-api', 'reason', 'migration')) FROM ins;
