-- Rollback for 20261003001000_payments_notifications.sql.
-- Restores the pre-Milestone-5 definitions of transition_order_status / checkout_place_order (the latter is
-- EFT-only again), removes the payment/notification functions, triggers and tables.
-- WARNING: this DROPS payment_transactions, webhook_events, webhook_rejections, fx_rates, payment_settings and
-- notification_events with all their rows. Orders already confirmed by a payment stay confirmed, but the
-- provider-side audit trail is lost, so EXPORT those tables first if the release has taken real payments.

BEGIN;

DROP TRIGGER IF EXISTS order_status_history_notify ON public.order_status_history;

CREATE OR REPLACE FUNCTION public.transition_order_status(
  p_order_id uuid,
  p_to_status text,
  p_actor_user_id uuid,
  p_note text DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders;
  v_role public.app_role;
BEGIN
  SELECT ur.role
  INTO v_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_actor_user_id
  ORDER BY public.role_level(ur.role) DESC
  LIMIT 1;

  IF v_role IS NULL OR public.role_level(v_role) < public.role_level('budtender'::public.app_role) THEN
    RAISE EXCEPTION 'staff access required';
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;

  IF NOT public.order_status_transition_allowed(v_order.status, p_to_status) THEN
    RAISE EXCEPTION 'invalid order status transition: % -> %', v_order.status, p_to_status;
  END IF;

  IF p_to_status = 'confirmed' AND v_order.status = 'awaiting_payment' THEN
    PERFORM public._consume_order_stock(p_order_id, p_actor_user_id);
  ELSIF p_to_status = 'cancelled' THEN
    PERFORM public._cancel_order_stock(p_order_id, p_actor_user_id);
  END IF;

  INSERT INTO public.order_status_history (order_id, from_status, to_status, actor_user_id, note)
  VALUES (p_order_id, v_order.status, p_to_status, p_actor_user_id, p_note);

  UPDATE public.orders
  SET status = p_to_status
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;

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
  PERFORM public._require_verified_member(p_user_id);
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

-- _eft_settle takes the payment_transactions row type, so it must go before the table does.
DROP FUNCTION IF EXISTS public._eft_settle(public.payment_transactions, uuid);

DROP TABLE IF EXISTS public.notification_events, public.webhook_rejections, public.webhook_events,
  public.payment_transactions, public.fx_rates, public.payment_settings CASCADE;

DROP FUNCTION IF EXISTS public._eft_threshold();
DROP FUNCTION IF EXISTS public._notify_order_status();
DROP FUNCTION IF EXISTS public._webhook_events_guard();
DROP FUNCTION IF EXISTS public.eft_approve(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.eft_reject(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.eft_submit(uuid, uuid, text, numeric, date, text, text);
DROP FUNCTION IF EXISTS public.fx_current_rate(text, text);
DROP FUNCTION IF EXISTS public.fx_record_live_rate(text, text, numeric, integer, text);
DROP FUNCTION IF EXISTS public.fx_set_rate(uuid, text, text, numeric, integer, text);
DROP FUNCTION IF EXISTS public.notification_claim(integer, integer);
DROP FUNCTION IF EXISTS public.notification_complete(uuid, boolean, text, text, boolean);
DROP FUNCTION IF EXISTS public.notification_enqueue(text, text, text, uuid, text, jsonb, text, integer);
DROP FUNCTION IF EXISTS public.notification_enqueue_staff(text, jsonb, text, public.app_role);
DROP FUNCTION IF EXISTS public.payment_attach_session(uuid, text, text);
DROP FUNCTION IF EXISTS public.payment_initiate(uuid, uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.payment_mark_failed(uuid, text);
DROP FUNCTION IF EXISTS public.payments_apply_verified_event(text, text, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.payments_expire_stale();
DROP FUNCTION IF EXISTS public.webhook_reject(text, text, text, text);

COMMIT;
