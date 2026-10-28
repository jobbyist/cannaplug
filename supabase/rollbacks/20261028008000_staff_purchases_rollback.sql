-- Rollback for 20261028008000_staff_purchases: puts back the previous checkout, loyalty redemption, till sale and sales
-- report functions and removes the staff columns and helpers. Refused once any staff purchase has been recorded (the
-- flag and the discount would be lost); revert the code, keep the migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.orders WHERE staff_purchase)
     OR EXISTS (SELECT 1 FROM public.pos_sales WHERE staff_purchase) THEN
    RAISE EXCEPTION 'rollback_blocked: staff purchases exist; keep this migration or export them first';
  END IF;
END $$;

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

CREATE OR REPLACE FUNCTION public.pos_complete_sale(
  p_actor uuid,
  p_session_id uuid,
  p_items jsonb,
  p_tenders jsonb,
  p_customer_id uuid,
  p_idempotency_key text,
  p_order_discount jsonb DEFAULT NULL,
  p_discount_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_role public.app_role;
  v_session public.pos_sessions;
  v_line record;
  v_tender record;
  v_priced jsonb := '[]'::jsonb;
  v_name text;
  v_price numeric(10,2);
  v_total numeric(10,2) := 0;
  v_gross_c bigint := 0;
  v_line_disc_c bigint := 0;
  v_net_c bigint := 0;
  v_order_disc_c bigint := 0;
  v_oalloc jsonb;
  v_discounts jsonb;
  v_unit_c bigint;
  v_gross_line_c bigint;
  v_ld_c bigint;
  v_reason text := NULLIF(btrim(COALESCE(p_discount_reason, '')), '');
  v_tender_sum numeric(10,2) := 0;
  v_sale_id uuid := gen_random_uuid();
  v_receipt text;
  v_item_id uuid;
  v_alloc record;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_sale', p_actor, p_idempotency_key,
    jsonb_build_object('session', p_session_id, 'items', p_items, 'tenders', p_tenders, 'customer', p_customer_id,
                       'od', p_order_discount, 'dr', p_discount_reason));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- Structural validation. Only product_id + quantity are read from items: client prices are ignored.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,3}$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  IF p_tenders IS NULL OR jsonb_typeof(p_tenders) <> 'array' OR jsonb_array_length(p_tenders) NOT BETWEEN 0 AND 8
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_tenders) t
       WHERE jsonb_typeof(t) <> 'object'
          OR (t->>'method') NOT IN ('cash', 'card', 'eft', 'paypal')
          OR (t->>'amount') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
          OR (t->>'amount')::numeric <= 0
          OR ((t->>'method') = 'cash' AND (t->>'reference') IS NOT NULL)
          OR ((t->>'method') <> 'cash' AND length(COALESCE(t->>'reference', '')) NOT BETWEEN 4 AND 100)) THEN
    RAISE EXCEPTION 'invalid_tenders: method cash|card|eft|paypal, amount > 0 (max 2 decimals), non-cash needs a 4-100 char reference';
  END IF;

  -- Session: shared lock so a concurrent till close waits for this sale (and vice versa).
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
  IF v_session.opened_by <> p_actor AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'session_not_yours';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;

  -- Price every line from the database. FOR SHARE pins the price for the life of this transaction.
  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity,
           COALESCE(jsonb_agg(DISTINCT e->'discount') FILTER (WHERE jsonb_typeof(e->'discount') = 'object'), '[]'::jsonb) AS discounts
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
    ORDER BY 1
  LOOP
    -- An online-only sale is not offered at the till: the till charges the regular price.
    SELECT p.name,
           CASE WHEN p.sale_online_only AND p.regular_price_rand IS NOT NULL THEN p.regular_price_rand ELSE p.price_rand END
    INTO v_name, v_price
    FROM public.products p WHERE p.id = v_line.product_id AND p.is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'product_unavailable: %', v_line.product_id; END IF;
    IF jsonb_array_length(v_line.discounts) > 1 THEN
      RAISE EXCEPTION 'invalid_discount: one product cannot carry two different discounts';
    END IF;
    v_unit_c := round(v_price * 100)::bigint;
    v_gross_line_c := v_unit_c * v_line.quantity;
    v_ld_c := public._pos_discount_cents(v_line.discounts->0, v_gross_line_c);
    v_gross_c := v_gross_c + v_gross_line_c;
    v_line_disc_c := v_line_disc_c + v_ld_c;
    v_priced := v_priced || jsonb_build_array(jsonb_build_object(
      'product_id', v_line.product_id, 'name', v_name, 'unit_price', v_price,
      'quantity', v_line.quantity, 'item_id', gen_random_uuid(),
      'line_discount_c', v_ld_c, 'net_c', v_gross_line_c - v_ld_c));
  END LOOP;

  -- Order discount: taken off what is left after the line discounts, then shared across the lines
  -- (largest remainder, to the cent) so that every line still knows what was really paid for it.
  v_net_c := v_gross_c - v_line_disc_c;
  v_order_disc_c := public._pos_discount_cents(p_order_discount, v_net_c);
  IF v_line_disc_c + v_order_disc_c > 0 THEN
    IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 200 THEN
      RAISE EXCEPTION 'discount_reason_required: give a reason of 3-200 characters for the discount';
    END IF;
    -- Any role may discount by any percentage up to 100% (owner decision, 28 Oct 2026), with no approval. Every
    -- discount still needs a reason and is audited. A 100% discount makes a R0 sale: it has no tenders.
  END IF;
  SELECT COALESCE(jsonb_object_agg(r.product_id::text, r.alloc), '{}'::jsonb) INTO v_oalloc
  FROM (
    SELECT q.product_id,
           q.floor_c + CASE WHEN q.rn <= (v_order_disc_c - SUM(q.floor_c) OVER ()) THEN 1 ELSE 0 END AS alloc
    FROM (
      SELECT x.product_id,
             COALESCE(floor(v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0)), 0)::bigint AS floor_c,
             row_number() OVER (ORDER BY COALESCE((v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0))
                                         - floor(v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0)), 0) DESC, x.product_id) AS rn
      FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, net_c bigint)
    ) q
  ) r;
  v_total := (v_net_c - v_order_disc_c)::numeric / 100;

  -- Server-side tender validation: sum(tenders) must equal the server-computed total exactly.
  SELECT COALESCE(SUM((t->>'amount')::numeric), 0) INTO v_tender_sum FROM jsonb_array_elements(p_tenders) t;
  IF v_tender_sum <> v_total THEN
    RAISE EXCEPTION 'tender_mismatch: tendered % but sale total is %', v_tender_sum, v_total;
  END IF;

  -- Serialise use of external payment references (also against webhook-confirmed orders).
  FOR v_tender IN
    SELECT DISTINCT (t->>'method') AS method, (t->>'reference') AS reference
    FROM jsonb_array_elements(p_tenders) t WHERE (t->>'reference') IS NOT NULL
    ORDER BY 2, 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || v_tender.method || ':' || v_tender.reference, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || v_tender.reference, 1));
    IF EXISTS (SELECT 1 FROM public.pos_tenders x WHERE x.method = v_tender.method AND x.reference = v_tender.reference)
       OR EXISTS (SELECT 1 FROM public.payment_events pe WHERE pe.provider = v_tender.method AND pe.provider_event_id = v_tender.reference) THEN
      RAISE EXCEPTION 'payment_reference_in_use: % reference % was already recorded', v_tender.method, v_tender.reference;
    END IF;
  END LOOP;

  v_receipt := 'POS-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('public.pos_receipt_seq')::text, 6, '0');
  INSERT INTO public.pos_sales (id, receipt_number, session_id, cashier_id, customer_id, subtotal, discount_rand,
                                discount_reason, total, idempotency_key)
  VALUES (v_sale_id, v_receipt, p_session_id, p_actor, p_customer_id, v_gross_c::numeric / 100,
          (v_line_disc_c + v_order_disc_c)::numeric / 100,
          CASE WHEN v_line_disc_c + v_order_disc_c > 0 THEN v_reason END, v_total,
          p_actor::text || ':' || p_idempotency_key);

  FOR v_tender IN SELECT (t->>'method') AS method, (t->>'amount')::numeric(10,2) AS amount, (t->>'reference') AS reference
                  FROM jsonb_array_elements(p_tenders) t LOOP
    INSERT INTO public.pos_tenders (sale_id, method, amount, reference)
    VALUES (v_sale_id, v_tender.method, v_tender.amount, v_tender.reference);
  END LOOP;

  FOR v_line IN
    SELECT x.product_id, x.name, x.unit_price, x.quantity, x.item_id, x.line_discount_c,
           COALESCE((v_oalloc->>(x.product_id::text))::bigint, 0) AS order_discount_c
    FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, name text, unit_price numeric, quantity integer, item_id uuid, line_discount_c bigint)
    ORDER BY x.product_id
  LOOP
    INSERT INTO public.pos_sale_items (id, sale_id, product_id, product_name, unit_price_rand, quantity,
                                       line_discount_rand, order_discount_rand, line_total)
    VALUES (v_line.item_id, v_sale_id, v_line.product_id, v_line.name, v_line.unit_price, v_line.quantity,
            v_line.line_discount_c::numeric / 100, v_line.order_discount_c::numeric / 100,
            v_line.unit_price * v_line.quantity - (v_line.line_discount_c + v_line.order_discount_c)::numeric / 100);

    PERFORM public._expire_holds(v_line.product_id);
    FOR v_alloc IN SELECT * FROM public._allocate_fefo(v_line.product_id, v_line.quantity) LOOP
      INSERT INTO public.inventory_ledger
        (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
      VALUES
        (v_alloc.o_batch_id, v_line.product_id, -v_alloc.o_quantity, 'POS sale ' || v_receipt,
         'pos_sale_item', v_line.item_id, p_actor, 'pos_sale');
    END LOOP;
  END LOOP;

  IF v_line_disc_c + v_order_disc_c > 0 THEN
    PERFORM public._audit(p_actor, 'pos_sale_discount', 'pos_sale', v_sale_id, jsonb_build_object(
      'receipt_number', v_receipt, 'gross', v_gross_c::numeric / 100, 'line_discounts', v_line_disc_c::numeric / 100,
      'order_discount', v_order_disc_c::numeric / 100, 'total', v_total, 'reason', v_reason));
  END IF;

  v_response := jsonb_build_object(
    'sale_id', v_sale_id, 'receipt_number', v_receipt, 'total', v_total, 'session_id', p_session_id,
    'subtotal', v_gross_c::numeric / 100, 'discount', (v_line_disc_c + v_order_disc_c)::numeric / 100,
    'customer_id', p_customer_id,
    'items', (SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                'quantity', i.quantity, 'unit_price', i.unit_price_rand, 'line_discount', i.line_discount_rand,
                'order_discount', i.order_discount_rand, 'line_total', i.line_total) ORDER BY i.product_name)
              FROM public.pos_sale_items i WHERE i.sale_id = v_sale_id),
    'tenders', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount, 'reference', t.reference) ORDER BY t.created_at, t.id)
                         FROM public.pos_tenders t WHERE t.sale_id = v_sale_id), '[]'::jsonb));
  RETURN public._idem_finish('pos_sale', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) TO service_role;


CREATE OR REPLACE FUNCTION public.sales_report(p_actor uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  RETURN public._sales_report(p_from, p_to);
END;
$$;

REVOKE ALL ON FUNCTION public.checkout_place_order(uuid, jsonb, text, text, text, uuid, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_place_order(uuid, jsonb, text, text, text, uuid, text, numeric, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.redeem_loyalty_points(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, uuid, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.sales_report(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_report(uuid, date, date) TO service_role;

DROP FUNCTION IF EXISTS public._sales_report_staff(date, date);
DROP FUNCTION IF EXISTS public.pos_customer_search(uuid, text, integer);
DROP FUNCTION IF EXISTS public.checkout_quote_for(uuid, jsonb, text);
DROP INDEX IF EXISTS public.orders_staff_purchase_idx;
DROP INDEX IF EXISTS public.pos_sales_staff_purchase_idx;
ALTER TABLE public.orders DROP COLUMN IF EXISTS staff_purchase, DROP COLUMN IF EXISTS staff_discount_rand;
ALTER TABLE public.pos_sales DROP COLUMN IF EXISTS staff_purchase, DROP COLUMN IF EXISTS staff_discount_rand;
DROP FUNCTION IF EXISTS public._is_staff(uuid);
DROP FUNCTION IF EXISTS public.staff_purchase_percent();
