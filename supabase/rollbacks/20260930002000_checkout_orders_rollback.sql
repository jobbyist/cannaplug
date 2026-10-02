-- Rollback for the checkout migration (20260930002000_checkout_orders.sql).
-- Orders already placed keep their rows; the delivery/payment columns on them are dropped (the address
-- snapshot is lost) — export them first if any real orders exist.

-- Restore the Milestone 4 versions of the four functions exactly as they were.
CREATE OR REPLACE FUNCTION public.redeem_loyalty_points(
  p_user_id uuid,
  p_order_id uuid,
  p_points integer,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_order public.orders;
  v_subtotal numeric(10,2);
  v_rate numeric := public._loyalty_rule('redeem_rand_per_point');
  v_min integer := public._loyalty_rule('redeem_min_points')::integer;
  v_pct numeric := public._loyalty_rule('redeem_max_pct_of_order');
  v_max_discount numeric(10,2);
  v_max_points integer;
  v_discount numeric(10,2);
  v_balance integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_cached := public._idem_begin('loyalty_redeem', p_user_id, p_idempotency_key,
    jsonb_build_object('order', p_order_id, 'points', p_points));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;
  IF p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'invalid_points: enter a whole number of points above zero';
  END IF;

  -- Ownership is part of the lookup: someone else's order is indistinguishable from a missing one.
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;
  IF v_order.status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'order_not_redeemable: points can only be applied to an order that is awaiting payment';
  END IF;
  IF v_order.loyalty_points_redeemed > 0
     OR EXISTS (SELECT 1 FROM public.loyalty_transactions t WHERE t.source_type = 'order_redeem' AND t.source_id = p_order_id) THEN
    RAISE EXCEPTION 'redemption_exists: points were already applied to this order';
  END IF;
  IF p_points < v_min THEN
    RAISE EXCEPTION 'below_minimum: the minimum redemption is % points', v_min;
  END IF;

  SELECT COALESCE(SUM(oi.unit_price_rand * oi.quantity), 0)::numeric(10,2) INTO v_subtotal
  FROM public.order_items oi WHERE oi.order_id = p_order_id;
  v_max_discount := (floor(v_subtotal * v_pct) / 100)::numeric(10,2);
  v_max_points := floor(v_max_discount / v_rate)::integer;
  IF p_points > v_max_points THEN
    RAISE EXCEPTION 'exceeds_order_limit: at most % points can be applied to this order', v_max_points;
  END IF;

  -- The ledger trigger locks the account, re-checks the balance and records balance_after.
  INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points)
  VALUES (p_user_id, 'redeem', 'order_redeem', p_order_id, p_order_id, -p_points)
  RETURNING balance_after INTO v_balance;

  v_discount := round(p_points * v_rate, 2);
  UPDATE public.orders
  SET loyalty_points_redeemed = p_points,
      loyalty_discount_rand = v_discount,
      total_rand = v_subtotal - v_discount
  WHERE id = p_order_id;

  PERFORM public._audit(p_user_id, 'loyalty_points_redeemed', 'order', p_order_id,
    jsonb_build_object('points', p_points, 'discount', v_discount, 'balance_after', v_balance));
  v_response := jsonb_build_object('order_id', p_order_id, 'points', p_points, 'discount', v_discount,
    'total', v_subtotal - v_discount, 'balance', v_balance);
  RETURN public._idem_finish('loyalty_redeem', p_user_id, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.accrue_order_loyalty(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_points integer;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('accrued', false, 'reason', 'order_not_found'); END IF;
  IF v_order.status <> 'completed' THEN RETURN jsonb_build_object('accrued', false, 'reason', 'not_completed'); END IF;
  -- Points are earned on what was actually paid (after any redeemed points).
  v_points := public._loyalty_points_for_amount(v_order.total_rand);
  IF v_points <= 0 THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_points'); END IF;
  INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, order_id, points)
  VALUES (v_order.user_id, 'earn', 'order', v_order.id, v_order.id, v_points)
  ON CONFLICT (source_type, source_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('accrued', true, 'points', v_points);
  END IF;
  RETURN jsonb_build_object('accrued', false, 'reason', 'already_accrued');
END;
$$;

CREATE OR REPLACE FUNCTION public.reorder_check(p_user_id uuid, p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_lines jsonb;
  v_total numeric(10,2);
  v_orderable boolean;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;

  WITH grouped AS (
    SELECT oi.product_id, SUM(oi.quantity)::integer AS quantity,
           (array_agg(oi.product_name ORDER BY oi.id))[1] AS product_name,
           (array_agg(oi.unit_price_rand ORDER BY oi.id))[1] AS previous_price
    FROM public.order_items oi WHERE oi.order_id = p_order_id
    GROUP BY oi.product_id
  ), checked AS (
    SELECT g.product_id, g.quantity, COALESCE(p.name, g.product_name) AS name, g.previous_price,
           p.price_rand AS current_price,
           CASE WHEN p.id IS NULL OR NOT p.is_active THEN 0 ELSE public._product_available(p.id) END AS available,
           (p.id IS NOT NULL AND p.is_active) AS is_active
    FROM grouped g LEFT JOIN public.products p ON p.id = g.product_id
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'product_id', c.product_id, 'name', c.name, 'quantity', c.quantity,
      'previous_price', c.previous_price, 'current_price', c.current_price,
      'available', c.available,
      'status', CASE WHEN NOT c.is_active THEN 'unavailable'
                     WHEN c.available < c.quantity THEN 'insufficient_stock'
                     WHEN c.current_price <> c.previous_price THEN 'price_changed'
                     ELSE 'ok' END) ORDER BY c.name),
    bool_and(c.is_active AND c.available >= c.quantity),
    SUM(c.current_price * c.quantity) FILTER (WHERE c.is_active)
  INTO v_lines, v_orderable, v_total
  FROM checked c;

  RETURN jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number,
    'lines', COALESCE(v_lines, '[]'::jsonb),
    'orderable', COALESCE(v_orderable, false),
    'current_total', CASE WHEN COALESCE(v_orderable, false) THEN v_total ELSE NULL END);
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
    'Reorder of ' || v_source.order_number, 'ro-' || md5(p_idempotency_key), 30);
  v_result := v_result || jsonb_build_object('source_order_id', p_source_order_id);
  RETURN public._idem_finish('reorder', p_user_id, p_idempotency_key, v_result);
END;
$$;

DROP FUNCTION IF EXISTS public.checkout_place_order(uuid, jsonb, text, text, text, uuid, text, numeric, text, text);
DROP FUNCTION IF EXISTS public.checkout_quote(jsonb, text);
DROP FUNCTION IF EXISTS public._checkout_apply_delivery(uuid, text, jsonb, text);

ALTER TABLE public.orders
  DROP COLUMN IF EXISTS delivery_method,
  DROP COLUMN IF EXISTS delivery_fee_rand,
  DROP COLUMN IF EXISTS delivery_address,
  DROP COLUMN IF EXISTS payment_method;
COMMENT ON COLUMN public.orders.total_rand IS
  'Amount payable (item subtotal minus loyalty_discount_rand). Payment confirmation compares against this.';
DROP TABLE IF EXISTS public.delivery_options;
