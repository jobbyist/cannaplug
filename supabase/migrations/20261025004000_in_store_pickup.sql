-- 25 Oct 2026: in-store pickup for online orders.
--   * delivery_options gains is_pickup + pickup_address; a free 'collection' option (In-store pickup) at
--     Shop 002, One On Mutual, Pretoria Central.
--   * checkout_place_order: a pickup order needs no saved address; the order stores the shop address as its
--     delivery_address snapshot (so the existing "method and address set together" rule still holds).
--   * transition_order_status: a pickup order goes ready -> completed (collected); it can never be sent out for
--     delivery, and a delivery order still cannot skip out_for_delivery.

ALTER TABLE public.delivery_options
  ADD COLUMN IF NOT EXISTS is_pickup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pickup_address text CHECK (pickup_address IS NULL OR length(pickup_address) <= 200);

INSERT INTO public.delivery_options (code, label, description, fee_rand, is_active, sort_order, is_pickup, pickup_address)
VALUES ('collection', 'In-store pickup', 'Collect at the shop. Bring your ID.', 0, true, 0, true,
        'Shop 002, One On Mutual, Pretoria Central')
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description, fee_rand = 0, is_active = true,
      sort_order = 0, is_pickup = true, pickup_address = EXCLUDED.pickup_address;

-- Whether an order is collected in store.
CREATE OR REPLACE FUNCTION public._order_is_pickup(p_method text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((SELECT d.is_pickup FROM public.delivery_options d WHERE d.code = p_method), false)
$$;

CREATE OR REPLACE FUNCTION public.checkout_place_order(p_user_id uuid, p_items jsonb, p_contact_name text, p_contact_phone text, p_delivery_method text, p_address_id uuid, p_payment_method text, p_expected_total numeric, p_notes text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_quote jsonb;
  v_address public.addresses;
  v_option public.delivery_options;
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
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('eft', 'card', 'paypal') THEN
    RAISE EXCEPTION 'payment_method_unsupported: choose EFT, card or PayPal';
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

  SELECT * INTO v_option FROM public.delivery_options WHERE code = p_delivery_method AND is_active;
  IF FOUND AND v_option.is_pickup THEN
    -- Collected in store: the shop is the "address"; no saved address is needed or used.
    v_snapshot := jsonb_build_object('label', 'In-store pickup', 'pickup', true,
      'recipient_name', btrim(p_contact_name), 'phone', btrim(p_contact_phone),
      'line1', v_option.pickup_address, 'city', 'Pretoria', 'country', 'ZA');
  ELSE
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
  END IF;

  v_quote := public.checkout_quote(p_items, p_delivery_method);
  IF NOT (v_quote->>'orderable')::boolean THEN
    SELECT string_agg(l->>'name', ', ') INTO v_bad
    FROM jsonb_array_elements(v_quote->'lines') l WHERE l->>'status' <> 'ok';
    RAISE EXCEPTION 'checkout_unavailable: %', COALESCE(v_bad, 'no items');
  END IF;
  IF (v_quote->>'total')::numeric IS DISTINCT FROM p_expected_total THEN
    RAISE EXCEPTION 'price_changed: the current total is R%', (v_quote->>'total');
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.transition_order_status(p_order_id uuid, p_to_status text, p_actor_user_id uuid, p_note text DEFAULT NULL::text)
 RETURNS public.orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_order public.orders;
  v_role public.app_role;
  v_pickup boolean;
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

  v_pickup := public._order_is_pickup(v_order.delivery_method);
  IF v_pickup AND v_order.status = 'ready' AND p_to_status = 'out_for_delivery' THEN
    RAISE EXCEPTION 'pickup_order: this order is collected in store; mark it completed when the customer collects it';
  END IF;
  IF NOT (public.order_status_transition_allowed(v_order.status, p_to_status)
          OR (v_pickup AND v_order.status = 'ready' AND p_to_status = 'completed')) THEN
    RAISE EXCEPTION 'invalid order status transition: % -> %', v_order.status, p_to_status;
  END IF;

  IF p_to_status = 'confirmed' AND v_order.status = 'awaiting_payment' THEN
    RAISE EXCEPTION 'payment_confirmation_required: an unpaid order is confirmed by a verified payment (provider webhook or the EFT verification workflow), not by a status change';
  END IF;

  IF p_to_status = 'cancelled' THEN
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
$function$;

REVOKE ALL ON FUNCTION public._order_is_pickup(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._order_is_pickup(text) TO service_role;
