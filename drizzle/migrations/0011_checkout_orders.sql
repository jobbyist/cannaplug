-- Checkout end to end: server-priced checkout that creates a real order which reaches /admin and /account.
--
--   * delivery_options      server-owned delivery fees (the browser never supplies a price)
--   * orders                + delivery_method / delivery_fee_rand / delivery_address (snapshot) / payment_method
--   * checkout_quote        read-only: re-prices a basket against today's catalogue + stock
--   * checkout_place_order  one transaction: validate -> refuse if the total moved -> create order + hold stock
--   * M4 functions patched  so the delivery fee is part of the payable total but does not earn points:
--                           redeem_loyalty_points, accrue_order_loyalty, reorder_check, create_reorder
--
-- There is deliberately no card/wallet capture here: no payment processor is integrated. Orders are
-- placed as `awaiting_payment` with an EFT reference; staff confirm receipt through
-- confirm_order_payment (idempotent per bank reference, amount-checked, audited).

CREATE TABLE public.delivery_options (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  label text NOT NULL,
  description text,
  fee_rand numeric(10,2) NOT NULL CHECK (fee_rand >= 0),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO public.delivery_options (code, label, description, fee_rand, sort_order) VALUES
  ('standard', 'Standard delivery', '2–3 working days', 80, 1),
  ('discreet', 'Discreet delivery', 'Plain packaging, in-hand', 120, 2);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_method text REFERENCES public.delivery_options(code),
  ADD COLUMN IF NOT EXISTS delivery_fee_rand numeric(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee_rand >= 0),
  ADD COLUMN IF NOT EXISTS delivery_address jsonb,
  ADD COLUMN IF NOT EXISTS payment_method text CHECK (payment_method IN ('eft', 'card', 'paypal', 'cash'));

-- A delivery method and its address snapshot always travel together: an order can never claim a delivery
-- method without the snapshot staff deliver to (or the reverse), and the snapshot is a JSON object.
-- Deliberately NOT `delivery_address NOT NULL`: orders are created by create_online_order first and
-- stamped by _checkout_apply_delivery in the same transaction, and older / staff-created orders
-- legitimately have no delivery details.
ALTER TABLE public.orders
  ADD CONSTRAINT orders_delivery_snapshot_chk
    CHECK ((delivery_method IS NULL) = (delivery_address IS NULL)),
  ADD CONSTRAINT orders_delivery_address_object_chk
    CHECK (delivery_address IS NULL OR jsonb_typeof(delivery_address) = 'object');

COMMENT ON COLUMN public.orders.delivery_address IS
  'Snapshot of the member address at order time (the saved address may later change or be deleted).';
COMMENT ON COLUMN public.orders.total_rand IS
  'Amount payable: item subtotal + delivery_fee_rand - loyalty_discount_rand. Payment confirmation compares against this.';

-- Fees are server-owned; clients may only read the active options.
ALTER TABLE public.delivery_options ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_options FROM anon, authenticated;
GRANT ALL ON public.delivery_options TO service_role;
GRANT SELECT ON public.delivery_options TO anon, authenticated;
CREATE POLICY "delivery options readable" ON public.delivery_options FOR SELECT TO anon, authenticated
  USING (is_active);

-- ---------------------------------------------------------------------------
-- Quote
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.checkout_quote(p_items jsonb, p_delivery_method text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_opt public.delivery_options;
  v_lines jsonb;
  v_subtotal numeric(10,2);
  v_orderable boolean;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,2}$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  SELECT * INTO v_opt FROM public.delivery_options WHERE code = p_delivery_method AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_delivery_method';
  END IF;

  WITH grouped AS (
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e GROUP BY 1
  ), checked AS (
    SELECT g.product_id, g.quantity, p.name, p.price_rand,
           (p.id IS NOT NULL AND p.is_active) AS is_active,
           CASE WHEN p.id IS NULL OR NOT p.is_active THEN 0 ELSE public._product_available(p.id) END AS available
    FROM grouped g LEFT JOIN public.products p ON p.id = g.product_id
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      'product_id', c.product_id, 'name', COALESCE(c.name, 'Unavailable product'), 'quantity', c.quantity,
      'unit_price', c.price_rand, 'line_total', c.price_rand * c.quantity, 'available', c.available,
      'status', CASE WHEN NOT c.is_active THEN 'unavailable'
                     WHEN c.available < c.quantity THEN 'insufficient_stock'
                     ELSE 'ok' END) ORDER BY c.name),
    bool_and(c.is_active AND c.available >= c.quantity),
    SUM(c.price_rand * c.quantity) FILTER (WHERE c.is_active)
  INTO v_lines, v_orderable, v_subtotal
  FROM checked c;

  RETURN jsonb_build_object(
    'lines', COALESCE(v_lines, '[]'::jsonb),
    'orderable', COALESCE(v_orderable, false),
    'subtotal', COALESCE(v_subtotal, 0),
    'delivery_method', v_opt.code, 'delivery_label', v_opt.label, 'delivery_fee', v_opt.fee_rand,
    'total', CASE WHEN COALESCE(v_orderable, false) THEN v_subtotal + v_opt.fee_rand ELSE NULL END);
END;
$$;

-- ---------------------------------------------------------------------------
-- Internal: stamp delivery + payment onto a freshly created order (fee joins the payable total)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._checkout_apply_delivery(
  p_order_id uuid, p_method text, p_address jsonb, p_payment text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_fee numeric(10,2);
BEGIN
  SELECT d.fee_rand INTO v_fee FROM public.delivery_options d WHERE d.code = p_method AND d.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_unavailable: that delivery option is no longer offered';
  END IF;
  UPDATE public.orders
  SET delivery_method = p_method, delivery_fee_rand = v_fee, delivery_address = p_address,
      payment_method = p_payment, total_rand = total_rand + v_fee
  WHERE id = p_order_id AND delivery_method IS NULL AND status = 'awaiting_payment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_already_set';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Place order
-- ---------------------------------------------------------------------------

-- The browser supplies: product ids + quantities, ONE OF ITS OWN saved address ids, a delivery option
-- code, contact details, and the total it displayed. Everything monetary is recomputed here; if the
-- total the member saw is not the live total, nothing is created.
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

-- ---------------------------------------------------------------------------
-- M4 functions, patched for the delivery fee (text lifted from the M4 migration by the build script)
-- ---------------------------------------------------------------------------

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
      total_rand = v_subtotal + v_order.delivery_fee_rand - v_discount
  WHERE id = p_order_id;

  PERFORM public._audit(p_user_id, 'loyalty_points_redeemed', 'order', p_order_id,
    jsonb_build_object('points', p_points, 'discount', v_discount, 'balance_after', v_balance));
  v_response := jsonb_build_object('order_id', p_order_id, 'points', p_points, 'discount', v_discount,
    'total', v_subtotal + v_order.delivery_fee_rand - v_discount, 'balance', v_balance);
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
  -- Points are earned on what was actually paid for goods: after any redeemed points, and
  -- excluding the delivery fee.
  v_points := public._loyalty_points_for_amount(v_order.total_rand - v_order.delivery_fee_rand);
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
  v_fee numeric(10,2) := 0;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found';
  END IF;
  -- Delivery is re-priced at today's fee; a retired option blocks the reorder.
  IF v_order.delivery_method IS NOT NULL THEN
    SELECT d.fee_rand INTO v_fee FROM public.delivery_options d
    WHERE d.code = v_order.delivery_method AND d.is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'delivery_unavailable: the delivery option on that order is no longer offered';
    END IF;
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
    'delivery_fee', v_fee,
    'current_total', CASE WHEN COALESCE(v_orderable, false) THEN v_total + v_fee ELSE NULL END);
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

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY['checkout_quote', 'checkout_place_order', '_checkout_apply_delivery'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;
