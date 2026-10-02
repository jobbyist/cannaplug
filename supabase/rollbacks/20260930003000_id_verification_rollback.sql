-- Rollback for 20260930003000_id_verification.sql.
-- Restores the checkout-migration definitions of checkout_place_order / create_reorder (no ID gate), the
-- Milestone 2 customer_verification policies and grants, and removes the review columns and functions.
-- The `id-documents` storage bucket and the files in it are intentionally LEFT IN PLACE: they are member
-- personal information, so deleting them is a deliberate decision, never a side effect of a rollback.
-- Verification rows are dropped with their columns' data only where the columns go; status itself is kept.

BEGIN;

CREATE OR REPLACE FUNCTION public.checkout_place_order(
  p_user_id uuid,
  p_items jsonb,
  p_contact_name text,
  p_contact_phone text,
  p_delivery_method text,
  p_address_id uuid,
  p_payment_method text,
  p_expected_total numeric,
  p_notes text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_quote jsonb;
  v_address public.addresses;
  v_snapshot jsonb;
  v_bad text;
  v_result jsonb;
  v_order public.orders;
  c_hold constant integer := 120;
BEGIN
  PERFORM public._require_read_committed();
  IF p_expected_total IS NULL THEN
    RAISE EXCEPTION 'expected_total_required: confirm the current total before placing the order';
  END IF;
  IF p_payment_method IS DISTINCT FROM 'eft' THEN
    RAISE EXCEPTION 'payment_method_unsupported: only EFT is available right now';
  END IF;
  IF length(btrim(COALESCE(p_contact_name, ''))) NOT BETWEEN 2 AND 160
     OR COALESCE(p_contact_phone, '') !~ '^[0-9+() -]{7,40}$' THEN
    RAISE EXCEPTION 'invalid_contact: a name and a valid phone number are required';
  END IF;

  v_cached := public._idem_begin('checkout', p_user_id, p_idempotency_key,
    jsonb_build_object('items', p_items, 'name', p_contact_name, 'phone', p_contact_phone,
                       'method', p_delivery_method, 'address', p_address_id, 'pay', p_payment_method,
                       'total', p_expected_total, 'notes', p_notes));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- Ownership is part of the lookup: another member's address is indistinguishable from a missing one.
  SELECT * INTO v_address FROM public.addresses WHERE id = p_address_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'address_not_found';
  END IF;
  IF COALESCE(btrim(v_address.city), '') = '' AND COALESCE(btrim(v_address.suburb), '') = '' THEN
    RAISE EXCEPTION 'address_incomplete: add a suburb or city to this address';
  END IF;
  v_snapshot := jsonb_build_object(
    'label', v_address.label, 'recipient_name', v_address.recipient_name, 'phone', v_address.phone,
    'line1', v_address.line1, 'line2', v_address.line2, 'suburb', v_address.suburb, 'city', v_address.city,
    'province', v_address.province, 'postal_code', v_address.postal_code, 'country', v_address.country,
    'delivery_notes', v_address.delivery_notes);

  v_quote := public.checkout_quote(p_items, p_delivery_method);
  IF NOT (v_quote->>'orderable')::boolean THEN
    SELECT string_agg(l->>'name', ', ') INTO v_bad
    FROM jsonb_array_elements(v_quote->'lines') l WHERE l->>'status' <> 'ok';
    RAISE EXCEPTION 'checkout_unavailable: %', COALESCE(v_bad, 'no items');
  END IF;
  IF (v_quote->>'total')::numeric IS DISTINCT FROM p_expected_total THEN
    RAISE EXCEPTION 'price_changed: the current total is R%', (v_quote->>'total');
  END IF;

  -- Server pricing + stock hold (an unpaid EFT order keeps its stock for c_hold minutes).
  v_result := public.create_online_order(
    p_user_id,
    (SELECT jsonb_agg(jsonb_build_object('product_id', l->>'product_id', 'quantity', (l->>'quantity')::integer))
     FROM jsonb_array_elements(v_quote->'lines') l),
    btrim(p_contact_name), btrim(p_contact_phone), p_notes,
    'co-' || md5(p_idempotency_key), c_hold);

  PERFORM public._checkout_apply_delivery((v_result->>'order_id')::uuid, p_delivery_method, v_snapshot, p_payment_method);
  SELECT * INTO v_order FROM public.orders WHERE id = (v_result->>'order_id')::uuid;

  PERFORM public._audit(p_user_id, 'checkout_order_placed', 'order', v_order.id,
    jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_rand,
                       'delivery', p_delivery_method, 'payment', p_payment_method));
  v_result := jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
    'subtotal', (v_quote->>'subtotal')::numeric, 'delivery_fee', v_order.delivery_fee_rand,
    'total', v_order.total_rand, 'payment_method', v_order.payment_method, 'hold_minutes', c_hold);
  RETURN public._idem_finish('checkout', p_user_id, p_idempotency_key, v_result);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_reorder(
  p_user_id uuid,
  p_source_order_id uuid,
  p_expected_total numeric,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_check jsonb;
  v_source public.orders;
  v_items jsonb;
  v_result jsonb;
  v_bad text;
BEGIN
  PERFORM public._require_read_committed();
  IF p_expected_total IS NULL THEN
    RAISE EXCEPTION 'expected_total_required: confirm the current total before reordering';
  END IF;
  v_cached := public._idem_begin('reorder', p_user_id, p_idempotency_key,
    jsonb_build_object('order', p_source_order_id, 'total', p_expected_total));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  v_check := public.reorder_check(p_user_id, p_source_order_id);
  IF NOT (v_check->>'orderable')::boolean THEN
    SELECT string_agg(l->>'name', ', ') INTO v_bad
    FROM jsonb_array_elements(v_check->'lines') l WHERE l->>'status' IN ('unavailable', 'insufficient_stock');
    RAISE EXCEPTION 'reorder_unavailable: %', COALESCE(v_bad, 'no items');
  END IF;
  IF (v_check->>'current_total')::numeric IS DISTINCT FROM p_expected_total THEN
    RAISE EXCEPTION 'price_changed: the current total is R%', (v_check->>'current_total');
  END IF;

  SELECT * INTO v_source FROM public.orders WHERE id = p_source_order_id AND user_id = p_user_id;
  SELECT jsonb_agg(jsonb_build_object('product_id', l->>'product_id', 'quantity', (l->>'quantity')::integer))
  INTO v_items FROM jsonb_array_elements(v_check->'lines') l;

  v_result := public.create_online_order(
    p_user_id, v_items, v_source.contact_name, v_source.contact_phone,
    'Reorder of ' || v_source.order_number, 'ro-' || md5(p_idempotency_key), 120);
  -- Carry the delivery method, address snapshot and payment method over (fee re-priced today).
  IF v_source.delivery_method IS NOT NULL THEN
    PERFORM public._checkout_apply_delivery((v_result->>'order_id')::uuid, v_source.delivery_method,
      v_source.delivery_address, COALESCE(v_source.payment_method, 'eft'));
    v_result := v_result || jsonb_build_object('total',
      (SELECT o.total_rand FROM public.orders o WHERE o.id = (v_result->>'order_id')::uuid));
  END IF;
  v_result := v_result || jsonb_build_object('source_order_id', p_source_order_id);
  RETURN public._idem_finish('reorder', p_user_id, p_idempotency_key, v_result);
END;
$$;

DROP FUNCTION IF EXISTS public.verification_review(uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.verification_log_document_view(uuid, uuid);
DROP FUNCTION IF EXISTS public.verification_submit(uuid, text, text, date, text);
DROP FUNCTION IF EXISTS public._require_verified_member(uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
             AND schemaname = 'public' AND tablename = 'customer_verification') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.customer_verification;
  END IF;
END
$$;

DROP INDEX IF EXISTS public.customer_verification_pending_idx;
ALTER TABLE public.customer_verification
  DROP CONSTRAINT IF EXISTS customer_verification_pending_evidence_chk,
  DROP CONSTRAINT IF EXISTS customer_verification_verified_chk,
  DROP COLUMN IF EXISTS document_type,
  DROP COLUMN IF EXISTS document_path,
  DROP COLUMN IF EXISTS declared_dob,
  DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS reviewed_at,
  DROP COLUMN IF EXISTS reviewed_by,
  DROP COLUMN IF EXISTS rejection_code,
  DROP COLUMN IF EXISTS rejection_note,
  DROP COLUMN IF EXISTS attempt_count;

REVOKE ALL ON public.customer_verification FROM anon, authenticated;
GRANT SELECT ON public.customer_verification TO authenticated;
GRANT INSERT (user_id, status, method, verified_at, verified_by, provider_reference, metadata)
  ON public.customer_verification TO authenticated;
GRANT UPDATE (status, method, verified_at, verified_by, provider_reference, metadata, updated_at)
  ON public.customer_verification TO authenticated;
GRANT ALL ON public.customer_verification TO service_role;

CREATE POLICY "verification management insert"
ON public.customer_verification FOR INSERT TO authenticated
WITH CHECK ((SELECT public.has_at_least_role('manager'::public.app_role)));

CREATE POLICY "verification management update"
ON public.customer_verification FOR UPDATE TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)))
WITH CHECK ((SELECT public.has_at_least_role('manager'::public.app_role)));

COMMIT;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['checkout_place_order', 'create_reorder'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;
