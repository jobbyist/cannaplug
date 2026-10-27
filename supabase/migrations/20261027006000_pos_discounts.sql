-- 27 Oct 2026: POS discounts.
--   The till can discount single lines and the whole order. Everything is worked out here, in whole cents,
--   from the database price: the browser only sends the kind (percent|amount) and value. A discount needs a
--   reason (3-200 characters) and is written to the audit log. Cashiers can give up to 20% off a sale;
--   managers and admins can give more, but a sale must still total more than R0.
--   Each line keeps what was really paid for it (line_total, after its own discount and its share of the order
--   discount), and refunds are pro-rated from that, so a refund never gives back more than was paid.
ALTER TABLE public.pos_sales
  ADD COLUMN IF NOT EXISTS discount_rand numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount_rand >= 0),
  ADD COLUMN IF NOT EXISTS discount_reason text CHECK (discount_reason IS NULL OR length(discount_reason) BETWEEN 3 AND 200);
ALTER TABLE public.pos_sale_items
  ADD COLUMN IF NOT EXISTS line_discount_rand numeric(10,2) NOT NULL DEFAULT 0 CHECK (line_discount_rand >= 0),
  ADD COLUMN IF NOT EXISTS order_discount_rand numeric(10,2) NOT NULL DEFAULT 0 CHECK (order_discount_rand >= 0);

ALTER TABLE public.pos_sales DROP CONSTRAINT IF EXISTS pos_sales_total_chk;
ALTER TABLE public.pos_sales ADD CONSTRAINT pos_sales_total_chk CHECK (total = subtotal - discount_rand);
ALTER TABLE public.pos_sale_items DROP CONSTRAINT IF EXISTS pos_sale_items_line_chk;
ALTER TABLE public.pos_sale_items ADD CONSTRAINT pos_sale_items_line_chk
  CHECK (line_total >= 0 AND line_total = unit_price_rand * quantity - line_discount_rand - order_discount_rand);

-- Cents taken off `p_base_cents` by a discount {"kind":"percent"|"amount","value":"10"}; NULL means no discount.
CREATE OR REPLACE FUNCTION public._pos_discount_cents(p_spec jsonb, p_base_cents bigint)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_kind text;
  v_value text;
  v_cents bigint;
BEGIN
  IF p_spec IS NULL OR p_spec = 'null'::jsonb THEN RETURN 0; END IF;
  IF jsonb_typeof(p_spec) <> 'object' THEN RAISE EXCEPTION 'invalid_discount'; END IF;
  v_kind := p_spec->>'kind';
  v_value := p_spec->>'value';
  IF v_kind IS NULL OR v_kind NOT IN ('percent', 'amount') OR v_value IS NULL
     OR v_value !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$' THEN
    RAISE EXCEPTION 'invalid_discount: kind percent|amount and a value with up to 2 decimals';
  END IF;
  IF v_kind = 'percent' THEN
    IF v_value::numeric > 100 THEN RAISE EXCEPTION 'invalid_discount: a percentage is 0-100'; END IF;
    v_cents := round(p_base_cents * v_value::numeric / 100)::bigint;
  ELSE
    v_cents := round(v_value::numeric * 100)::bigint;
  END IF;
  IF v_cents > p_base_cents THEN
    RAISE EXCEPTION 'discount_too_large: a discount cannot be more than the amount it applies to';
  END IF;
  RETURN v_cents;
END;
$$;
REVOKE ALL ON FUNCTION public._pos_discount_cents(jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._pos_discount_cents(jsonb, bigint) TO service_role;

-- The six-argument sale function is replaced by one that also takes the order discount and its reason.
DROP FUNCTION IF EXISTS public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text);

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
  IF p_tenders IS NULL OR jsonb_typeof(p_tenders) <> 'array' OR jsonb_array_length(p_tenders) NOT BETWEEN 1 AND 8
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
  IF v_net_c - v_order_disc_c <= 0 THEN
    RAISE EXCEPTION 'discount_too_large: the sale total must stay above zero';
  END IF;
  IF v_line_disc_c + v_order_disc_c > 0 THEN
    IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 200 THEN
      RAISE EXCEPTION 'discount_reason_required: give a reason of 3-200 characters for the discount';
    END IF;
    -- Cashiers can give up to 20% off a sale; larger discounts need a manager or admin.
    IF public.role_level(v_role) < public.role_level('manager')
       AND (v_line_disc_c + v_order_disc_c) * 5 > v_gross_c THEN
      RAISE EXCEPTION 'discount_limit: cashiers can discount up to 20%% of a sale; ask a manager';
    END IF;
  END IF;
  SELECT COALESCE(jsonb_object_agg(r.product_id::text, r.alloc), '{}'::jsonb) INTO v_oalloc
  FROM (
    SELECT q.product_id,
           q.floor_c + CASE WHEN q.rn <= (v_order_disc_c - SUM(q.floor_c) OVER ()) THEN 1 ELSE 0 END AS alloc
    FROM (
      SELECT x.product_id,
             floor(v_order_disc_c * x.net_c::numeric / v_net_c)::bigint AS floor_c,
             row_number() OVER (ORDER BY (v_order_disc_c * x.net_c::numeric / v_net_c)
                                         - floor(v_order_disc_c * x.net_c::numeric / v_net_c) DESC, x.product_id) AS rn
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
    'tenders', (SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount, 'reference', t.reference) ORDER BY t.created_at, t.id)
                FROM public.pos_tenders t WHERE t.sale_id = v_sale_id));
  RETURN public._idem_finish('pos_sale', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) TO service_role;

CREATE OR REPLACE FUNCTION public.pos_refund_sale(
  p_actor uuid,
  p_sale_id uuid,
  p_session_id uuid,
  p_items jsonb,
  p_payouts jsonb,
  p_reason text,
  p_restock boolean,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_sale public.pos_sales;
  v_session public.pos_sessions;
  v_line record;
  v_item public.pos_sale_items;
  v_amount numeric(10,2) := 0;
  v_tendered numeric(10,2);
  v_refunded numeric(10,2);
  v_payout record;
  v_refund_id uuid := gen_random_uuid();
  v_batches uuid[];
  v_mv record;
  v_left integer;
  v_put integer;
  v_all_refunded boolean;
  v_target integer;
  v_current integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('pos_refund', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_sale_id, 'ses', p_session_id, 'i', p_items, 'm', p_payouts, 'r', p_reason, 'k', p_restock));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_payouts IS NULL OR jsonb_typeof(p_payouts) <> 'array' OR jsonb_array_length(p_payouts) NOT BETWEEN 1 AND 4
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_payouts) t
       WHERE jsonb_typeof(t) <> 'object'
          OR (t->>'method') NOT IN ('cash', 'card', 'eft', 'paypal')
          OR (t->>'amount') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
          OR (t->>'amount')::numeric <= 0
          OR ((t->>'method') = 'cash' AND (t->>'reference') IS NOT NULL)
          OR ((t->>'reference') IS NOT NULL AND length(t->>'reference') NOT BETWEEN 4 AND 100)) THEN
    RAISE EXCEPTION 'invalid_tenders: refund payouts need method cash|card|eft|paypal and amount > 0';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-500 characters is mandatory';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'sale_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,3}$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale_not_found'; END IF;
  IF v_sale.status NOT IN ('completed', 'partially_refunded') THEN
    RAISE EXCEPTION 'invalid_sale_state: % sales cannot be refunded', v_sale.status;
  END IF;
  -- The refund is paid out of a currently open till session.
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed: refunds need an open till session'; END IF;

  FOR v_line IN
    SELECT (e->>'sale_item_id')::uuid AS sale_item_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e GROUP BY 1 ORDER BY 1
  LOOP
    SELECT * INTO v_item FROM public.pos_sale_items WHERE id = v_line.sale_item_id AND sale_id = p_sale_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_items: line % is not part of this sale', v_line.sale_item_id; END IF;
    IF v_item.refunded_quantity + v_line.quantity > v_item.quantity THEN
      RAISE EXCEPTION 'over_refund: % of % already refunded for %; requested %',
        v_item.refunded_quantity, v_item.quantity, v_item.product_name, v_line.quantity;
    END IF;
    -- A line's refund is its share of what was actually paid (line_total, after any discount), rounded so the
    -- shares of a full refund add up to line_total to the cent.
    v_amount := v_amount
      + round(v_item.line_total * (v_item.refunded_quantity + v_line.quantity) / v_item.quantity, 2)
      - round(v_item.line_total * v_item.refunded_quantity / v_item.quantity, 2);
  END LOOP;

  -- The payouts must add up to the server-computed refund, and no method may be refunded more than
  -- was tendered with it (net of earlier refunds).
  IF (SELECT SUM((t->>'amount')::numeric) FROM jsonb_array_elements(p_payouts) t) <> v_amount THEN
    RAISE EXCEPTION 'refund_mismatch: payouts % but refund total is %',
      (SELECT SUM((t->>'amount')::numeric) FROM jsonb_array_elements(p_payouts) t), v_amount;
  END IF;
  FOR v_payout IN
    SELECT (t->>'method') AS method, SUM((t->>'amount')::numeric)::numeric(10,2) AS amount
    FROM jsonb_array_elements(p_payouts) t GROUP BY 1 ORDER BY 1
  LOOP
    SELECT COALESCE(SUM(t.amount), 0) INTO v_tendered FROM public.pos_tenders t
    WHERE t.sale_id = p_sale_id AND t.method = v_payout.method;
    SELECT COALESCE(SUM(po.amount), 0) INTO v_refunded
    FROM public.pos_refund_payouts po JOIN public.pos_refunds r ON r.id = po.refund_id
    WHERE r.sale_id = p_sale_id AND po.method = v_payout.method;
    IF v_refunded + v_payout.amount > v_tendered THEN
      RAISE EXCEPTION 'over_refund: % refund of % exceeds % tendered (already refunded %)',
        v_payout.method, v_payout.amount, v_tendered, v_refunded;
    END IF;
  END LOOP;

  IF COALESCE(p_restock, false) THEN
    SELECT array_agg(DISTINCT l.batch_id) INTO v_batches
    FROM public.inventory_ledger l
    WHERE l.reference_type = 'pos_sale_item' AND l.movement_type = 'pos_sale'
      AND l.reference_id IN (SELECT (e->>'sale_item_id')::uuid FROM jsonb_array_elements(p_items) e);
    PERFORM public._lock_batches(v_batches);
  END IF;

  INSERT INTO public.pos_refunds (id, sale_id, session_id, actor_user_id, amount, reason, restocked, idempotency_key)
  VALUES (v_refund_id, p_sale_id, p_session_id, p_actor, v_amount, btrim(p_reason), COALESCE(p_restock, false),
          p_actor::text || ':' || p_idempotency_key);
  FOR v_payout IN
    SELECT (t->>'method') AS method, (t->>'amount')::numeric(10,2) AS amount, (t->>'reference') AS reference
    FROM jsonb_array_elements(p_payouts) t
  LOOP
    INSERT INTO public.pos_refund_payouts (refund_id, method, amount, reference)
    VALUES (v_refund_id, v_payout.method, v_payout.amount, v_payout.reference);
  END LOOP;

  FOR v_line IN
    SELECT (e->>'sale_item_id')::uuid AS sale_item_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e GROUP BY 1 ORDER BY 1
  LOOP
    INSERT INTO public.pos_refund_items (refund_id, sale_item_id, quantity) VALUES (v_refund_id, v_line.sale_item_id, v_line.quantity);
    UPDATE public.pos_sale_items SET refunded_quantity = refunded_quantity + v_line.quantity WHERE id = v_line.sale_item_id;

    IF COALESCE(p_restock, false) THEN
      v_left := v_line.quantity;
      FOR v_mv IN
        SELECT l.batch_id, l.product_id, -l.quantity_delta AS qty
        FROM public.inventory_ledger l
        WHERE l.reference_type = 'pos_sale_item' AND l.reference_id = v_line.sale_item_id AND l.movement_type = 'pos_sale'
        ORDER BY l.batch_id, l.id
      LOOP
        EXIT WHEN v_left = 0;
        -- Return no more to a batch than was taken from it (net of earlier returns).
        SELECT LEAST(v_left, v_mv.qty - COALESCE((
          SELECT SUM(r.quantity_delta) FROM public.inventory_ledger r
          WHERE r.batch_id = v_mv.batch_id AND r.movement_type = 'pos_refund_restock'
            AND r.reference_type = 'pos_refund_item'
            AND r.reference_id IN (SELECT ri.id FROM public.pos_refund_items ri WHERE ri.sale_item_id = v_line.sale_item_id)), 0))
        INTO v_put;
        IF v_put > 0 THEN
          INSERT INTO public.inventory_ledger
            (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
          SELECT v_mv.batch_id, v_mv.product_id, v_put, 'POS refund ' || v_sale.receipt_number,
                 'pos_refund_item', ri.id, p_actor, 'pos_refund_restock'
          FROM public.pos_refund_items ri WHERE ri.refund_id = v_refund_id AND ri.sale_item_id = v_line.sale_item_id;
          v_left := v_left - v_put;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  SELECT bool_and(i.refunded_quantity = i.quantity) INTO v_all_refunded FROM public.pos_sale_items i WHERE i.sale_id = p_sale_id;
  UPDATE public.pos_sales SET status = CASE WHEN v_all_refunded THEN 'refunded' ELSE 'partially_refunded' END WHERE id = p_sale_id;

  -- Reverse loyalty only if it was already accrued; otherwise accrual will use the net amount.
  SELECT COALESCE(SUM(points), 0) INTO v_current FROM public.loyalty_ledger WHERE sale_id = p_sale_id;
  IF v_current > 0 THEN
    v_target := public._loyalty_points_for_amount(v_sale.total - (SELECT COALESCE(SUM(r.amount), 0) FROM public.pos_refunds r WHERE r.sale_id = p_sale_id));
    IF v_target < v_current THEN
      INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
      VALUES (v_sale.customer_id, p_sale_id, 'pos_refund', v_refund_id, v_target - v_current);
    END IF;
  END IF;

  PERFORM public._audit(p_actor, 'pos_sale_refunded', 'pos_sale', p_sale_id,
    jsonb_build_object('receipt', v_sale.receipt_number, 'refund_id', v_refund_id, 'amount', v_amount,
                       'payouts', p_payouts, 'reason', btrim(p_reason), 'restocked', COALESCE(p_restock, false),
                       'session_id', p_session_id));
  v_response := jsonb_build_object('refund_id', v_refund_id, 'sale_id', p_sale_id, 'amount', v_amount,
    'status', CASE WHEN v_all_refunded THEN 'refunded' ELSE 'partially_refunded' END);
  RETURN public._idem_finish('pos_refund', p_actor, p_idempotency_key, v_response);
END;
$$;

