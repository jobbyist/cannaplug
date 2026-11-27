-- Rollback for 20261127004000_pay_in_store: restores checkout_place_order from 20261028008000 (online methods only, 2-hour hold) and create_online_order's 2-hour hold cap and drops the in-store payment function.
-- Orders already placed or paid with 'cash' keep their status and history.
DROP FUNCTION IF EXISTS public.order_take_in_store_payment(uuid, uuid, text, text);

-- create_online_order back to the 2-hour hold cap (as in 20260929010000).
CREATE OR REPLACE FUNCTION public.create_online_order(
  p_user_id uuid,
  p_items jsonb,
  p_contact_name text,
  p_contact_phone text,
  p_notes text,
  p_idempotency_key text,
  p_hold_minutes integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_line record;
  v_order public.orders;
  v_total numeric(10,2) := 0;
  v_ttl integer := LEAST(GREATEST(COALESCE(p_hold_minutes, 30), 5), 120);
  v_item_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  -- Inventory-denial guard: one customer cannot park unlimited stock behind unpaid holds.
  IF (SELECT COUNT(DISTINCT r.order_id)
      FROM public.stock_reservations r JOIN public.orders o ON o.id = r.order_id
      WHERE o.user_id = p_user_id AND r.status = 'held' AND r.expires_at > now()) >= 5 THEN
    RAISE EXCEPTION 'too_many_open_orders: pay for or cancel an existing order before placing another';
  END IF;
  v_cached := public._idem_begin('online_order', p_user_id, p_idempotency_key,
    jsonb_build_object('items', p_items, 'name', p_contact_name, 'phone', p_contact_phone, 'notes', p_notes));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,2}$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  INSERT INTO public.orders (user_id, contact_name, contact_phone, notes, total_rand)
  VALUES (p_user_id, left(p_contact_name, 160), left(p_contact_phone, 40), left(p_notes, 1000), 0)
  RETURNING * INTO v_order;

  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
    ORDER BY 1
  LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, quantity, unit_price_rand)
    SELECT v_order.id, p.id, p.name, v_line.quantity, p.price_rand
    FROM public.products p
    WHERE p.id = v_line.product_id AND p.is_active
    RETURNING id INTO v_item_id;
    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'product_unavailable: %', v_line.product_id;
    END IF;
    v_item_id := NULL;
  END LOOP;

  SELECT SUM(oi.unit_price_rand * oi.quantity)::numeric(10,2) INTO v_total
  FROM public.order_items oi WHERE oi.order_id = v_order.id;
  UPDATE public.orders SET total_rand = v_total WHERE id = v_order.id RETURNING * INTO v_order;

  INSERT INTO public.order_status_history (order_id, from_status, to_status, actor_user_id, note)
  VALUES (v_order.id, NULL, 'awaiting_payment', p_user_id, 'Order placed');

  PERFORM public._reserve_order_items(v_order.id, v_ttl);

  v_response := jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'total', v_order.total_rand,
    'status', v_order.status, 'hold_minutes', v_ttl);
  RETURN public._idem_finish('online_order', p_user_id, p_idempotency_key, v_response);
END;
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
  v_staff_disc numeric(10,2) := 0;
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

  v_quote := public.checkout_quote_for(p_user_id, p_items, p_delivery_method);
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

  -- Staff rate: every staff member (budtender, manager, admin) gets staff_purchase_percent() off the goods, worked out
  -- here from the order's own lines (never from the browser). The delivery fee is added after, and is not discounted.
  IF public._is_staff(p_user_id) THEN
    UPDATE public.orders
    SET staff_purchase = true,
        staff_discount_rand = round(total_rand * public.staff_purchase_percent() / 100, 2),
        total_rand = total_rand - round(total_rand * public.staff_purchase_percent() / 100, 2)
    WHERE id = (v_result->>'order_id')::uuid AND status = 'awaiting_payment'
    RETURNING staff_discount_rand INTO v_staff_disc;
  END IF;
  PERFORM public._checkout_apply_delivery((v_result->>'order_id')::uuid, p_delivery_method, v_snapshot, p_payment_method);
  SELECT * INTO v_order FROM public.orders WHERE id = (v_result->>'order_id')::uuid;

  PERFORM public._audit(p_user_id, 'checkout_order_placed', 'order', v_order.id,
    jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_rand,
                       'delivery', p_delivery_method, 'payment', p_payment_method,
                       'staff_purchase', v_order.staff_purchase, 'staff_discount', v_order.staff_discount_rand));
  v_result := jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
    'subtotal', (v_quote->>'subtotal')::numeric, 'delivery_fee', v_order.delivery_fee_rand,
    'total', v_order.total_rand, 'payment_method', v_order.payment_method, 'hold_minutes', c_hold,
    'staff_purchase', v_order.staff_purchase, 'staff_discount', v_order.staff_discount_rand);
  RETURN public._idem_finish('checkout', p_user_id, p_idempotency_key, v_result);
END;
$function$;
