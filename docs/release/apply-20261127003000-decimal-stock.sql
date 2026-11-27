-- Cannaplug: apply 20261127003000_decimal_stock to the hosted project (khltynzzcjhlujxbgyod).
-- Exact decimal stock: weighed products can be received, adjusted, counted and sold to one decimal place (27.4 g).
-- Runs as one transaction: everything applies, or nothing does. Paste all of it into the Supabase SQL Editor and click Run.
-- It briefly locks the stock tables while the columns are converted: run it when the shop is quiet (a minute at most).
-- The migration file is included unchanged. Needs every earlier migration (20261108002000 custom items is the latest).
BEGIN;

-- ===== 20261127003000_decimal_stock =====
-- 25 Nov 2026: exact decimal stock (client request: "allow decimals for stock take"; answers: scale reads 0.1 g,
-- half grams are sold rarely, and stock must be exact).
--
-- Until now every stock number was a whole number. Weighed products (counted in grams) can now be held, received,
-- adjusted and counted to one decimal place (27.4 g); everything else is still whole units.
--
--   * inventory_batches.qty_on_hand / qty_held, inventory_ledger.quantity_delta, stock_reservations.quantity,
--     order_items.quantity, pos_sale_items.quantity / refunded_quantity, pos_refund_items.quantity and
--     stock_take_lines.counted_qty / expected_at_count / posted_delta become numeric(12,1). Existing whole numbers convert exactly.
--   * A product that is not sold by weight must still be whole: _assert_stock_qty (receive, adjust, quick add/remove,
--     delivery, stock take) and _enforce_sale_step (every online and till sale line) refuse 2.5 pre-rolls.
--   * Selling: a weighed product is sold in its own step (weight_step_g: 0.5, 1 or 5 g). The 0.5 option already
--     existed in the product editor but could not work with whole-number stock; it works now. Everything else is
--     sold in whole units.
--   * Money: a sale line is priced as round(unit price x quantity, 2) (to the cent, half up), then discounts come
--     off. The same rule is used for online orders, quotes and reorders, so a basket always adds up to its order.
--   * The two stock views and every function that did integer arithmetic on stock are replaced (their bodies are the
--     live definitions with only the quantity types and parsing changed). Functions whose signature or return type
--     changes are dropped and recreated with the same service-role-only grants.
--   * Rollback converts the columns back to integers, and refuses while any stock or sale line holds a decimal.
--
-- Run it in the Supabase SQL Editor inside one transaction (docs/release/apply-20261127003000-decimal-stock.sql): it
-- briefly locks the stock tables while the columns are converted, so apply it when the shop is quiet.

-- 1. The two views and the two sale-step triggers depend on the columns being converted: drop them first and
-- recreate them below.
DROP VIEW IF EXISTS public.inventory_availability;
DROP VIEW IF EXISTS public.stock_movements;
DROP TRIGGER IF EXISTS order_items_sale_step ON public.order_items;
DROP TRIGGER IF EXISTS pos_sale_items_sale_step ON public.pos_sale_items;

-- 2. Quantities become exact to one decimal.
ALTER TABLE public.inventory_batches
  ALTER COLUMN qty_on_hand TYPE numeric(12,1),
  ALTER COLUMN qty_held TYPE numeric(12,1);
ALTER TABLE public.inventory_ledger ALTER COLUMN quantity_delta TYPE numeric(12,1);
ALTER TABLE public.stock_reservations ALTER COLUMN quantity TYPE numeric(12,1);
ALTER TABLE public.order_items ALTER COLUMN quantity TYPE numeric(12,1);
ALTER TABLE public.pos_sale_items
  ALTER COLUMN quantity TYPE numeric(12,1),
  ALTER COLUMN refunded_quantity TYPE numeric(12,1);
ALTER TABLE public.pos_refund_items ALTER COLUMN quantity TYPE numeric(12,1);
ALTER TABLE public.stock_take_lines
  ALTER COLUMN counted_qty TYPE numeric(12,1),
  ALTER COLUMN expected_at_count TYPE numeric(12,1),
  ALTER COLUMN posted_delta TYPE numeric(12,1);

-- A till line is worked out to the cent: round(unit price x quantity, 2) less its discounts.
ALTER TABLE public.pos_sale_items DROP CONSTRAINT IF EXISTS pos_sale_items_line_chk;
ALTER TABLE public.pos_sale_items ADD CONSTRAINT pos_sale_items_line_chk CHECK (
  line_total >= 0
  AND line_total = round(unit_price_rand * quantity, 2) - line_discount_rand - order_discount_rand);

-- 3. New helper: is this quantity allowed for this product? At most one decimal, and whole units unless the product
-- is sold by weight. Used by every function that takes a stock quantity from staff.
CREATE OR REPLACE FUNCTION public._assert_stock_qty(p_product_id uuid, p_qty numeric)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_name text;
  v_weight boolean;
BEGIN
  IF p_qty IS NULL THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_qty <> round(p_qty, 1) THEN
    RAISE EXCEPTION 'invalid_quantity: use at most one decimal place (for example 27.4)';
  END IF;
  IF p_qty = trunc(p_qty) THEN RETURN; END IF;
  SELECT p.name, p.sold_by_weight INTO v_name, v_weight FROM public.products p WHERE p.id = p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_unavailable: %', p_product_id; END IF;
  IF NOT v_weight THEN
    RAISE EXCEPTION 'invalid_quantity: % is counted in whole units, not decimals', v_name;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._assert_stock_qty(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._assert_stock_qty(uuid, numeric) TO service_role;

-- 4. Stock helpers (signature or return type changes: dropped and recreated).

DROP FUNCTION IF EXISTS public._allocate_fefo(uuid, integer);
CREATE OR REPLACE FUNCTION public._allocate_fefo(p_product_id uuid, p_quantity numeric)
 RETURNS TABLE(o_batch_id uuid, o_quantity numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_remaining numeric := p_quantity;
  v_avail numeric;
  v_take numeric;
  r record;
BEGIN
  FOR r IN
    SELECT b.id
    FROM public.inventory_batches b
    WHERE b.product_id = p_product_id
      AND (b.expires_at IS NULL OR b.expires_at > now())
    ORDER BY b.expires_at NULLS LAST, b.received_at, b.id
    FOR UPDATE
  LOOP
    -- Re-read under the lock: never trust values captured before the lock was granted.
    SELECT b.qty_on_hand - b.qty_held INTO v_avail FROM public.inventory_batches b WHERE b.id = r.id;
    v_take := LEAST(v_remaining, GREATEST(v_avail, 0));
    IF v_take > 0 THEN
      o_batch_id := r.id;
      o_quantity := v_take;
      RETURN NEXT;
      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'insufficient_stock: product % requested % available %',
      p_product_id, p_quantity, p_quantity - v_remaining;
  END IF;
END;
$function$;

DROP FUNCTION IF EXISTS public._product_on_hand(uuid);
CREATE OR REPLACE FUNCTION public._product_on_hand(p_product_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(sum(b.qty_on_hand), 0) FROM public.inventory_batches b WHERE b.product_id = p_product_id;
$function$;

DROP FUNCTION IF EXISTS public._product_available(uuid);
CREATE OR REPLACE FUNCTION public._product_available(p_product_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE(SUM(b.qty_on_hand - b.qty_held), 0)
  FROM public.inventory_batches b
  WHERE b.product_id = p_product_id AND (b.expires_at IS NULL OR b.expires_at > now());
$function$;

DROP FUNCTION IF EXISTS public._plug_units_7d();
CREATE OR REPLACE FUNCTION public._plug_units_7d()
 RETURNS TABLE(product_id uuid, units numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT x.product_id, sum(x.qty) FROM (
    SELECT i.product_id, (i.quantity - COALESCE(i.refunded_quantity, 0)) AS qty
      FROM public.pos_sale_items i JOIN public.pos_sales s ON s.id = i.sale_id
     WHERE s.status <> 'voided' AND s.created_at >= now() - interval '7 days'
    UNION ALL
    SELECT i.product_id, i.quantity
      FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
     WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
       AND o.created_at >= now() - interval '7 days'
  ) x
  WHERE x.product_id IS NOT NULL
  GROUP BY x.product_id;
$function$;

DROP FUNCTION IF EXISTS public._purchased_today(uuid, text);
CREATE OR REPLACE FUNCTION public._purchased_today(p_member uuid, p_category text)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT COALESCE((
    SELECT sum(oi.quantity) FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    JOIN public.products p ON p.id = oi.product_id
    WHERE o.user_id = p_member AND o.status <> 'cancelled' AND p.category = p_category
      AND (o.created_at AT TIME ZONE 'Africa/Johannesburg')::date = (now() AT TIME ZONE 'Africa/Johannesburg')::date
  ), 0) + COALESCE((
    SELECT sum(si.quantity - si.refunded_quantity) FROM public.pos_sale_items si
    JOIN public.pos_sales s ON s.id = si.sale_id
    JOIN public.products p ON p.id = si.product_id
    WHERE s.customer_id = p_member AND s.status <> 'voided' AND p.category = p_category
      AND (s.created_at AT TIME ZONE 'Africa/Johannesburg')::date = (now() AT TIME ZONE 'Africa/Johannesburg')::date
  ), 0);
$function$;

DROP FUNCTION IF EXISTS public._reserve_order_items(uuid, integer);
CREATE OR REPLACE FUNCTION public._reserve_order_items(p_order_id uuid, p_ttl_minutes integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_item record;
  v_needed numeric;
  v_alloc record;
  v_added numeric := 0;
BEGIN
  FOR v_item IN
    SELECT oi.id, oi.product_id, oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id AND oi.product_id IS NOT NULL
    ORDER BY oi.product_id, oi.id
  LOOP
    PERFORM public._expire_holds(v_item.product_id);
    SELECT v_item.quantity - COALESCE(SUM(r.quantity), 0) INTO v_needed
    FROM public.stock_reservations r
    WHERE r.order_item_id = v_item.id AND r.status IN ('held', 'consumed');
    IF v_needed > 0 THEN
      FOR v_alloc IN SELECT * FROM public._allocate_fefo(v_item.product_id, v_needed) LOOP
        INSERT INTO public.stock_reservations
          (order_id, order_item_id, product_id, batch_id, quantity, expires_at)
        VALUES
          (p_order_id, v_item.id, v_item.product_id, v_alloc.o_batch_id, v_alloc.o_quantity,
           now() + make_interval(mins => p_ttl_minutes));
        v_added := v_added + v_alloc.o_quantity;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_added;
END;
$function$;

DROP FUNCTION IF EXISTS public._sale_step(uuid);
-- The size of one step when selling a product: its own weight step (0.5, 1 or 5 g) when sold by weight, otherwise 1.
CREATE OR REPLACE FUNCTION public._sale_step(p_product uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = ''
AS $$ SELECT COALESCE((SELECT CASE WHEN p.sold_by_weight AND p.weight_step_g > 0 THEN p.weight_step_g ELSE 1 END
                       FROM public.products p WHERE p.id = p_product), 1) $$;
REVOKE EXECUTE ON FUNCTION public._sale_step(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sale_step(uuid) TO service_role;

DROP FUNCTION IF EXISTS public._stock_move_product(uuid, uuid, integer, text, text, uuid, text);
CREATE OR REPLACE FUNCTION public._stock_move_product(p_actor uuid, p_product_id uuid, p_delta numeric, p_reason text, p_reference_type text, p_reference_id uuid, p_new_batch_prefix text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ids uuid[];
  v_before numeric;
  v_remaining numeric;
  v_avail numeric;
  v_take numeric;
  v_batch uuid;
  v_name text;
  v_code text;
  r record;
BEGIN
  SELECT p.name INTO v_name FROM public.products p WHERE p.id = p_product_id;
  IF v_name IS NULL THEN RAISE EXCEPTION 'product_unavailable: %', p_product_id; END IF;
  PERFORM public._assert_stock_qty(p_product_id, p_delta);
  SELECT array_agg(b.id) INTO v_ids FROM public.inventory_batches b WHERE b.product_id = p_product_id;
  PERFORM public._lock_batches(v_ids);
  v_before := public._product_on_hand(p_product_id);
  IF p_delta = 0 THEN
    RETURN jsonb_build_object('before', v_before, 'after', v_before);
  END IF;

  IF p_delta < 0 THEN
    v_remaining := -p_delta;
    FOR r IN
      SELECT b.id FROM public.inventory_batches b
      WHERE b.product_id = p_product_id
      ORDER BY b.expires_at NULLS LAST, b.received_at, b.id
    LOOP
      SELECT b.qty_on_hand - b.qty_held INTO v_avail FROM public.inventory_batches b WHERE b.id = r.id;
      v_take := LEAST(v_remaining, GREATEST(v_avail, 0));
      IF v_take > 0 THEN
        INSERT INTO public.inventory_ledger
          (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
        VALUES (r.id, p_product_id, -v_take, p_reason, p_reference_type, p_reference_id, p_actor, 'adjustment');
        v_remaining := v_remaining - v_take;
      END IF;
      EXIT WHEN v_remaining = 0;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'insufficient_stock: % has only % that is not held for online orders (asked to remove %)',
        v_name, -p_delta - v_remaining, -p_delta;
    END IF;
  ELSE
    SELECT b.id INTO v_batch FROM public.inventory_batches b
    WHERE b.product_id = p_product_id
    ORDER BY b.received_at DESC, b.id DESC LIMIT 1;
    IF v_batch IS NULL THEN
      v_code := p_new_batch_prefix || '-' || to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYYMMDD');
      INSERT INTO public.inventory_batches (product_id, batch_code, notes, created_by)
      VALUES (p_product_id, v_code, 'Created by ' || lower(p_reason), p_actor)
      ON CONFLICT (product_id, batch_code) DO NOTHING;
      SELECT b.id INTO v_batch FROM public.inventory_batches b
      WHERE b.product_id = p_product_id AND b.batch_code = v_code;
      IF v_batch IS NULL THEN
        RAISE EXCEPTION 'batch_unavailable: could not set up a batch for %, please try again', v_name;
      END IF;
      PERFORM public._lock_batches(ARRAY[v_batch]);
    END IF;
    INSERT INTO public.inventory_ledger
      (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
    VALUES (v_batch, p_product_id, p_delta, p_reason, p_reference_type, p_reference_id, p_actor, 'adjustment');
  END IF;

  RETURN jsonb_build_object('before', v_before, 'after', public._product_on_hand(p_product_id));
END;
$function$;

DROP FUNCTION IF EXISTS public.adjust_stock(uuid, uuid, integer, text, text);
CREATE OR REPLACE FUNCTION public.adjust_stock(p_actor uuid, p_batch_id uuid, p_delta numeric, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_batch public.inventory_batches;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('adjust_stock', p_actor, p_idempotency_key,
    jsonb_build_object('b', p_batch_id, 'd', p_delta, 'r', p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-300 characters is mandatory';
  END IF;

  PERFORM public._lock_batches(ARRAY[p_batch_id]);
  SELECT * INTO v_batch FROM public.inventory_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  PERFORM public._assert_stock_qty(v_batch.product_id, p_delta);
  IF p_delta < 0 AND v_batch.qty_on_hand + p_delta < v_batch.qty_held THEN
    RAISE EXCEPTION 'insufficient_stock: cannot reduce batch below held quantity (on hand %, held %, delta %)',
      v_batch.qty_on_hand, v_batch.qty_held, p_delta;
  END IF;

  INSERT INTO public.inventory_ledger
    (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
  VALUES (p_batch_id, v_batch.product_id, p_delta, btrim(p_reason), p_actor, 'adjustment');

  PERFORM public._audit(p_actor, 'stock_adjusted', 'inventory_batch', p_batch_id,
    jsonb_build_object('product_id', v_batch.product_id, 'delta', p_delta, 'reason', btrim(p_reason),
                       'before', v_batch.qty_on_hand, 'after', v_batch.qty_on_hand + p_delta));
  v_response := jsonb_build_object('batch_id', p_batch_id, 'before', v_batch.qty_on_hand, 'after', v_batch.qty_on_hand + p_delta);
  RETURN public._idem_finish('adjust_stock', p_actor, p_idempotency_key, v_response);
END;
$function$;

DROP FUNCTION IF EXISTS public.receive_stock(uuid, uuid, text, integer, timestamp with time zone, numeric, text, text);
CREATE OR REPLACE FUNCTION public.receive_stock(p_actor uuid, p_product_id uuid, p_batch_code text, p_quantity numeric, p_expires_at timestamp with time zone, p_unit_cost numeric, p_notes text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_batch_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('receive_stock', p_actor, p_idempotency_key,
    jsonb_build_object('p', p_product_id, 'c', p_batch_code, 'q', p_quantity, 'e', p_expires_at, 'u', p_unit_cost));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_quantity IS NULL OR p_quantity NOT BETWEEN 0.1 AND 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_batch_code IS NULL OR length(btrim(p_batch_code)) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'invalid_batch_code'; END IF;
  IF p_unit_cost IS NOT NULL AND (p_unit_cost < 0 OR p_unit_cost <> round(p_unit_cost, 2)) THEN RAISE EXCEPTION 'invalid_unit_cost'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN RAISE EXCEPTION 'product_unavailable: %', p_product_id; END IF;
  PERFORM public._assert_stock_qty(p_product_id, p_quantity);

  INSERT INTO public.inventory_batches (product_id, batch_code, expires_at, unit_cost_rand, notes, created_by)
  VALUES (p_product_id, btrim(p_batch_code), p_expires_at, p_unit_cost, left(p_notes, 500), p_actor)
  ON CONFLICT (product_id, batch_code) DO NOTHING;
  SELECT id INTO v_batch_id FROM public.inventory_batches
  WHERE product_id = p_product_id AND batch_code = btrim(p_batch_code);
  PERFORM public._lock_batches(ARRAY[v_batch_id]);

  INSERT INTO public.inventory_ledger
    (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
  VALUES (v_batch_id, p_product_id, p_quantity, 'Stock received', p_actor, 'receipt');

  PERFORM public._audit(p_actor, 'stock_received', 'inventory_batch', v_batch_id,
    jsonb_build_object('product_id', p_product_id, 'batch_code', btrim(p_batch_code), 'quantity', p_quantity));
  v_response := jsonb_build_object('batch_id', v_batch_id, 'quantity', p_quantity);
  RETURN public._idem_finish('receive_stock', p_actor, p_idempotency_key, v_response);
END;
$function$;

DROP FUNCTION IF EXISTS public.stock_quick_adjust(uuid, uuid, integer, text, text);
CREATE OR REPLACE FUNCTION public.stock_quick_adjust(p_actor uuid, p_product_id uuid, p_delta numeric, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_result jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('stock_quick_adjust', p_actor, p_idempotency_key,
    jsonb_build_object('p', p_product_id, 'd', p_delta, 'r', p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-300 characters is mandatory';
  END IF;

  v_result := public._stock_move_product(p_actor, p_product_id, p_delta, btrim(p_reason), NULL, NULL, 'ADJ');
  PERFORM public._audit(p_actor, 'stock_quick_adjusted', 'product', p_product_id,
    jsonb_build_object('delta', p_delta, 'reason', btrim(p_reason)) || v_result);
  RETURN public._idem_finish('stock_quick_adjust', p_actor, p_idempotency_key,
    v_result || jsonb_build_object('product_id', p_product_id));
END;
$function$;

DROP FUNCTION IF EXISTS public.stock_take_record_count(uuid, uuid, uuid, integer, text);
CREATE OR REPLACE FUNCTION public.stock_take_record_count(p_actor uuid, p_stock_take_id uuid, p_product_id uuid, p_counted numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_take public.stock_takes;
  v_category text;
  v_ids uuid[];
  v_expected numeric;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('stock_take_count', p_actor, p_idempotency_key,
    jsonb_build_object('t', p_stock_take_id, 'p', p_product_id, 'c', p_counted));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_counted IS NULL OR p_counted NOT BETWEEN 0 AND 1000000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;

  -- A shared lock: counts can be saved side by side, but not while the count is being posted or cancelled.
  SELECT * INTO v_take FROM public.stock_takes t WHERE t.id = p_stock_take_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_take_not_found'; END IF;
  IF v_take.status <> 'open' THEN RAISE EXCEPTION 'stock_take_closed: this count has already been posted or cancelled'; END IF;
  SELECT p.category INTO v_category FROM public.products p WHERE p.id = p_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_unavailable: %', p_product_id; END IF;
  PERFORM public._assert_stock_qty(p_product_id, p_counted);
  IF v_take.category IS NOT NULL AND v_category IS DISTINCT FROM v_take.category THEN
    RAISE EXCEPTION 'wrong_category: this count is only for %', v_take.category;
  END IF;

  -- The snapshot is taken under the product's batch locks, so it is exactly what the shelf should hold now.
  SELECT array_agg(b.id) INTO v_ids FROM public.inventory_batches b WHERE b.product_id = p_product_id;
  PERFORM public._lock_batches(v_ids);
  v_expected := public._product_on_hand(p_product_id);

  INSERT INTO public.stock_take_lines (stock_take_id, product_id, expected_at_count, counted_qty, counted_by, counted_at)
  VALUES (p_stock_take_id, p_product_id, v_expected, p_counted, p_actor, now())
  ON CONFLICT (stock_take_id, product_id) DO UPDATE
    SET expected_at_count = EXCLUDED.expected_at_count, counted_qty = EXCLUDED.counted_qty,
        counted_by = EXCLUDED.counted_by, counted_at = EXCLUDED.counted_at;

  PERFORM public._audit(p_actor, 'stock_counted', 'stock_take', p_stock_take_id,
    jsonb_build_object('product_id', p_product_id, 'expected', v_expected, 'counted', p_counted));
  v_response := jsonb_build_object('product_id', p_product_id, 'expected', v_expected, 'counted', p_counted,
                                   'difference', p_counted - v_expected);
  RETURN public._idem_finish('stock_take_count', p_actor, p_idempotency_key, v_response);
END;
$function$;

-- 5. Functions whose signature stays the same (CREATE OR REPLACE keeps their grants).

CREATE OR REPLACE FUNCTION public.stock_take_post(p_actor uuid, p_stock_take_id uuid, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_take public.stock_takes;
  v_delta numeric;
  v_lines integer := 0;
  v_changed integer := 0;
  v_over numeric := 0;
  v_under numeric := 0;
  r record;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('stock_take_post', p_actor, p_idempotency_key, jsonb_build_object('t', p_stock_take_id));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  SELECT * INTO v_take FROM public.stock_takes t WHERE t.id = p_stock_take_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_take_not_found'; END IF;
  IF v_take.status <> 'open' THEN RAISE EXCEPTION 'stock_take_closed: this count has already been posted or cancelled'; END IF;

  -- Products in a fixed order, so two transactions can never lock batches in opposite orders.
  FOR r IN
    SELECT l.product_id, l.expected_at_count, l.counted_qty FROM public.stock_take_lines l
    WHERE l.stock_take_id = p_stock_take_id ORDER BY l.product_id
  LOOP
    v_lines := v_lines + 1;
    -- Relative to what the system showed when this product was counted: later sales stay counted.
    v_delta := r.counted_qty - r.expected_at_count;
    IF v_delta <> 0 THEN
      PERFORM public._stock_move_product(p_actor, r.product_id, v_delta, 'Stock take count', 'stock_take',
                                         p_stock_take_id, 'COUNT');
      v_changed := v_changed + 1;
      IF v_delta > 0 THEN v_over := v_over + v_delta; ELSE v_under := v_under - v_delta; END IF;
    END IF;
    UPDATE public.stock_take_lines SET posted_delta = v_delta
    WHERE stock_take_id = p_stock_take_id AND product_id = r.product_id;
  END LOOP;

  UPDATE public.stock_takes SET status = 'posted', closed_by = p_actor, closed_at = now() WHERE id = p_stock_take_id;
  PERFORM public._audit(p_actor, 'stock_take_posted', 'stock_take', p_stock_take_id,
    jsonb_build_object('lines', v_lines, 'changed', v_changed, 'units_added', v_over, 'units_removed', v_under));
  RETURN public._idem_finish('stock_take_post', p_actor, p_idempotency_key,
    jsonb_build_object('stock_take_id', p_stock_take_id, 'lines', v_lines, 'changed', v_changed,
                       'units_added', v_over, 'units_removed', v_under));
END;
$function$;

CREATE OR REPLACE FUNCTION public.stock_receive_delivery(p_actor uuid, p_supplier text, p_reference text, p_lines jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_delivery uuid := gen_random_uuid();
  v_supplier text := NULLIF(btrim(COALESCE(p_supplier, '')), '');
  v_ref text := NULLIF(upper(regexp_replace(btrim(COALESCE(p_reference, '')), '[^A-Za-z0-9-]+', '-', 'g')), '');
  v_code text;
  v_line jsonb;
  v_product uuid;
  v_qty numeric;
  v_cost numeric;
  v_expires timestamptz;
  v_batch uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_units numeric := 0;
  v_n integer := 0;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('stock_receive_delivery', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_supplier, 'r', p_reference, 'l', p_lines));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid_lines: add between 1 and 200 products';
  END IF;
  IF v_supplier IS NOT NULL AND length(v_supplier) > 120 THEN RAISE EXCEPTION 'invalid_supplier'; END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 40 THEN RAISE EXCEPTION 'invalid_reference'; END IF;
  v_code := 'DEL-' || to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYYMMDD')
            || '-' || COALESCE(v_ref, upper(left(replace(v_delivery::text, '-', ''), 6)));

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    BEGIN
      v_product := (v_line ->> 'product_id')::uuid;
      v_qty := (v_line ->> 'quantity')::numeric;
      v_cost := NULLIF(v_line ->> 'unit_cost', '')::numeric;
      v_expires := NULLIF(v_line ->> 'expires_at', '')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_lines: a line has a value that is not a number or a date';
    END;
    IF v_product IS NULL THEN RAISE EXCEPTION 'invalid_lines: a line has no product'; END IF;
    IF v_product = ANY (v_seen) THEN RAISE EXCEPTION 'duplicate_product: each product can appear once per delivery'; END IF;
    v_seen := v_seen || v_product;
    IF v_qty IS NULL OR v_qty NOT BETWEEN 0.1 AND 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
    IF v_cost IS NOT NULL AND (v_cost < 0 OR v_cost <> round(v_cost, 2)) THEN RAISE EXCEPTION 'invalid_unit_cost'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = v_product) THEN
      RAISE EXCEPTION 'product_unavailable: %', v_product;
    END IF;
    PERFORM public._assert_stock_qty(v_product, v_qty);

    -- The same invoice entered twice on one day would add the stock twice: refuse it. A genuine second delivery on the
    -- same invoice gets its own reference (e.g. INV-0042-2).
    IF v_ref IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.inventory_batches b WHERE b.product_id = v_product AND b.batch_code = v_code
    ) THEN
      RAISE EXCEPTION 'delivery_already_received: % was already received today with reference %',
        (SELECT p.name FROM public.products p WHERE p.id = v_product), v_ref;
    END IF;
    INSERT INTO public.inventory_batches (product_id, batch_code, expires_at, unit_cost_rand, notes, created_by)
    VALUES (v_product, v_code, v_expires, v_cost,
            left(concat_ws(' · ', 'Delivery', 'Supplier: ' || v_supplier, 'Ref: ' || v_ref), 500), p_actor)
    ON CONFLICT (product_id, batch_code) DO NOTHING;
    SELECT b.id INTO v_batch FROM public.inventory_batches b WHERE b.product_id = v_product AND b.batch_code = v_code;
    PERFORM public._lock_batches(ARRAY[v_batch]);
    INSERT INTO public.inventory_ledger
      (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
    VALUES (v_batch, v_product, v_qty, 'Delivery received', 'delivery', v_delivery, p_actor, 'receipt');
    v_units := v_units + v_qty;
    v_n := v_n + 1;
  END LOOP;

  PERFORM public._audit(p_actor, 'delivery_received', 'delivery', v_delivery,
    jsonb_build_object('supplier', v_supplier, 'reference', v_ref, 'batch_code', v_code,
                       'lines', v_n, 'units', v_units));
  RETURN public._idem_finish('stock_receive_delivery', p_actor, p_idempotency_key,
    jsonb_build_object('delivery_id', v_delivery, 'batch_code', v_code, 'lines', v_n, 'units', v_units));
END;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_order_stock(p_order_id uuid, p_ttl_minutes integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_order public.orders;
  v_added numeric;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v_order.status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'invalid_order_state: only awaiting_payment orders can be reserved (%)', v_order.status;
  END IF;
  v_added := public._reserve_order_items(p_order_id, LEAST(GREATEST(COALESCE(p_ttl_minutes, 30), 5), 120));
  RETURN jsonb_build_object('order_id', p_order_id, 'newly_held', v_added);
END;
$function$;

CREATE OR REPLACE FUNCTION public._enforce_purchase_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_member uuid;
  v_limit public.purchase_limits;
  v_total numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.purchase_limits WHERE enabled) THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'order_items' THEN
    SELECT o.user_id INTO v_member FROM public.orders o WHERE o.id = NEW.order_id;
  ELSE
    SELECT s.customer_id INTO v_member FROM public.pos_sales s WHERE s.id = NEW.sale_id;
  END IF;
  IF v_member IS NULL THEN RETURN NULL; END IF;
  SELECT l.* INTO v_limit FROM public.purchase_limits l
  JOIN public.products p ON p.category = l.category
  WHERE p.id = NEW.product_id AND l.enabled;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- one member's purchases are counted one transaction at a time, so two tills cannot both slip under the limit
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase_limit:' || v_member::text, 0));
  v_total := public._purchased_today(v_member, v_limit.category);
  IF v_total > v_limit.daily_max THEN
    RAISE EXCEPTION 'purchase_limit_exceeded: % is limited to % per day', v_limit.category, v_limit.daily_max
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public._enforce_sale_step()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_step numeric;
  v_name text;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  v_step := public._sale_step(NEW.product_id);
  IF NEW.quantity % v_step <> 0 THEN
    SELECT p.name INTO v_name FROM public.products p WHERE p.id = NEW.product_id;
    IF v_step = 1 THEN
      RAISE EXCEPTION 'invalid_batch_size: % is sold in whole units (asked for %)', v_name, NEW.quantity;
    END IF;
    RAISE EXCEPTION 'invalid_batch_size: % is sold in steps of % g (asked for %)',
      v_name, trim_scale(v_step), trim_scale(NEW.quantity);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_items_sale_step BEFORE INSERT OR UPDATE OF quantity, product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_sale_step();
CREATE TRIGGER pos_sale_items_sale_step BEFORE INSERT OR UPDATE OF quantity, product_id ON public.pos_sale_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_sale_step();

-- 6. Online orders, quotes and reorders: decimal quantities, lines priced to the cent.

CREATE OR REPLACE FUNCTION public.create_online_order(p_user_id uuid, p_items jsonb, p_contact_name text, p_contact_phone text, p_notes text, p_idempotency_key text, p_hold_minutes integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          OR (e->>'quantity') !~ '^(0\.[1-9]|[1-9][0-9]{0,2}(\.[0-9])?)$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  INSERT INTO public.orders (user_id, contact_name, contact_phone, notes, total_rand)
  VALUES (p_user_id, left(p_contact_name, 160), left(p_contact_phone, 40), left(p_notes, 1000), 0)
  RETURNING * INTO v_order;

  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::numeric) AS quantity
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

  SELECT SUM(round(oi.unit_price_rand * oi.quantity, 2))::numeric(10,2) INTO v_total
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
$function$;

CREATE OR REPLACE FUNCTION public.checkout_quote(p_items jsonb, p_delivery_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
          OR (e->>'quantity') !~ '^(0\.[1-9]|[1-9][0-9]{0,2}(\.[0-9])?)$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  SELECT * INTO v_opt FROM public.delivery_options WHERE code = p_delivery_method AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_delivery_method';
  END IF;

  WITH grouped AS (
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::numeric) AS quantity
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
      'unit_price', c.price_rand, 'line_total', round(c.price_rand * c.quantity, 2), 'available', c.available,
      'status', CASE WHEN NOT c.is_active THEN 'unavailable'
                     WHEN c.available < c.quantity THEN 'insufficient_stock'
                     ELSE 'ok' END) ORDER BY c.name),
    bool_and(c.is_active AND c.available >= c.quantity),
    SUM(round(c.price_rand * c.quantity, 2)) FILTER (WHERE c.is_active)
  INTO v_lines, v_orderable, v_subtotal
  FROM checked c;

  RETURN jsonb_build_object(
    'lines', COALESCE(v_lines, '[]'::jsonb),
    'orderable', COALESCE(v_orderable, false),
    'subtotal', COALESCE(v_subtotal, 0),
    'delivery_method', v_opt.code, 'delivery_label', v_opt.label, 'delivery_fee', v_opt.fee_rand,
    'total', CASE WHEN COALESCE(v_orderable, false) THEN v_subtotal + v_opt.fee_rand ELSE NULL END);
END;
$function$;

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
    (SELECT jsonb_agg(jsonb_build_object('product_id', l->>'product_id', 'quantity', (l->>'quantity')::numeric))
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

CREATE OR REPLACE FUNCTION public.create_reorder(p_user_id uuid, p_source_order_id uuid, p_expected_total numeric, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_check jsonb;
  v_source public.orders;
  v_items jsonb;
  v_result jsonb;
  v_bad text;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._require_verified_member(p_user_id);
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
  SELECT jsonb_agg(jsonb_build_object('product_id', l->>'product_id', 'quantity', (l->>'quantity')::numeric))
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
$function$;

CREATE OR REPLACE FUNCTION public.reorder_check(p_user_id uuid, p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    SELECT oi.product_id, SUM(oi.quantity) AS quantity,
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
    SUM(round(c.current_price * c.quantity, 2)) FILTER (WHERE c.is_active)
  INTO v_lines, v_orderable, v_total
  FROM checked c;

  RETURN jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number,
    'lines', COALESCE(v_lines, '[]'::jsonb),
    'orderable', COALESCE(v_orderable, false),
    'delivery_fee', v_fee,
    'current_total', CASE WHEN COALESCE(v_orderable, false) THEN v_total + v_fee ELSE NULL END);
END;
$function$;

-- 7. Till sales and refunds.

CREATE OR REPLACE FUNCTION public.pos_complete_sale(p_actor uuid, p_session_id uuid, p_items jsonb, p_tenders jsonb, p_customer_id uuid, p_idempotency_key text, p_order_discount jsonb DEFAULT NULL::jsonb, p_discount_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_staff boolean := false;
  v_manual_c bigint := 0;
  v_staff_c bigint := 0;
  v_reward_c bigint := 0;
  v_reward_pts integer := 0;
  v_rw_cost integer;
  v_rw_name text;
  v_manual_line_c bigint := 0;
  v_custom record;
  v_custom_count integer := 0;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_sale', p_actor, p_idempotency_key,
    jsonb_build_object('session', p_session_id, 'items', p_items, 'tenders', p_tenders, 'customer', p_customer_id,
                       'od', p_order_discount, 'dr', p_discount_reason));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- Structural validation. For catalogue lines only product_id + quantity are read: client prices are ignored.
  -- A custom line (8 Nov 2026) is the one exception: it has no product, so the cashier types its name and price,
  -- which are validated here, stored on the sale line only and audited. It never touches stock or the catalogue.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'quantity') !~ '^(0\.[1-9]|[1-9][0-9]{0,3}(\.[0-9])?)$'
          OR ((e ? 'custom') AND (e->>'quantity') !~ '^[1-9][0-9]{0,3}$')
          OR ((e ? 'reward') AND (e->>'reward') !~ '^[a-z_]{3,40}$')
          OR (NOT (e ? 'custom')
              AND (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          OR ((e ? 'custom') AND (
                (e ? 'product_id') OR (e ? 'reward') OR jsonb_typeof(e->'custom') <> 'object'
                OR length(btrim(COALESCE(e->'custom'->>'name', ''))) NOT BETWEEN 2 AND 80
                OR (e->'custom'->>'name') ~ '[[:cntrl:]]'
                OR COALESCE(e->'custom'->>'price', '') !~ '^[0-9]{1,6}(\.[0-9]{1,2})?$'
                OR (e->'custom'->>'price')::numeric <= 0
                OR (e->'custom'->>'price')::numeric > 100000))) THEN
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
  -- Who may be attached as a staff customer (and so get the staff rate): see _pos_can_attach_staff.
  IF p_customer_id IS NOT NULL AND public._is_staff(p_customer_id)
     AND NOT public._pos_can_attach_staff(p_actor, p_customer_id) THEN
    RAISE EXCEPTION 'staff_attach_not_allowed: managers and admins can attach any staff member; a budtender can attach other budtenders, but not themselves';
  END IF;

  -- Price every line from the database. FOR SHARE pins the price for the life of this transaction.
  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::numeric) AS quantity,
           COALESCE(jsonb_agg(DISTINCT e->'discount') FILTER (WHERE jsonb_typeof(e->'discount') = 'object'), '[]'::jsonb) AS discounts,
           max(e->>'reward') AS reward
    FROM jsonb_array_elements(p_items) e
    WHERE NOT (e ? 'custom')
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
    v_gross_line_c := round(v_unit_c * v_line.quantity)::bigint;
    v_ld_c := public._pos_discount_cents(v_line.discounts->0, v_gross_line_c);
    -- Loyalty reward: one unit of an eligible product is free, paid for in points (deducted below, in this sale).
    IF v_line.reward IS NOT NULL THEN
      IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'reward_needs_member: attach the member to use a reward';
      END IF;
      IF jsonb_array_length(v_line.discounts) > 0 THEN
        RAISE EXCEPTION 'invalid_discount: a free reward item cannot also carry a discount';
      END IF;
      SELECT r.points_cost, r.name INTO v_rw_cost, v_rw_name
      FROM public.loyalty_rewards r WHERE r.code = v_line.reward AND r.is_active;
      IF NOT FOUND THEN RAISE EXCEPTION 'reward_unavailable: that reward is not available'; END IF;
      IF NOT public._reward_eligible(v_line.reward, v_line.product_id) THEN
        RAISE EXCEPTION 'reward_not_eligible: % is not covered by that reward', v_name;
      END IF;
      v_ld_c := v_unit_c;
      v_reward_c := v_reward_c + v_ld_c;
      v_reward_pts := v_reward_pts + v_rw_cost;
    END IF;
    v_gross_c := v_gross_c + v_gross_line_c;
    v_line_disc_c := v_line_disc_c + v_ld_c;
    v_priced := v_priced || jsonb_build_array(jsonb_build_object(
      'product_id', v_line.product_id, 'name', v_name, 'unit_price', v_price,
      'quantity', v_line.quantity, 'item_id', gen_random_uuid(),
      'line_discount_c', v_ld_c, 'net_c', v_gross_line_c - v_ld_c, 'is_custom', false));
  END LOOP;

  -- Custom lines: one line each (never merged), priced as typed, on the hidden placeholder product.
  FOR v_custom IN
    SELECT btrim(e->'custom'->>'name') AS name, (e->'custom'->>'price')::numeric(10,2) AS price,
           (e->>'quantity')::integer AS quantity,
           CASE WHEN jsonb_typeof(e->'discount') = 'object' THEN e->'discount' END AS discount
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n)
    WHERE e ? 'custom'
    ORDER BY n
  LOOP
    v_custom_count := v_custom_count + 1;
    v_unit_c := round(v_custom.price * 100)::bigint;
    v_gross_line_c := v_unit_c * v_custom.quantity;
    v_ld_c := public._pos_discount_cents(v_custom.discount, v_gross_line_c);
    v_gross_c := v_gross_c + v_gross_line_c;
    v_line_disc_c := v_line_disc_c + v_ld_c;
    v_priced := v_priced || jsonb_build_array(jsonb_build_object(
      'product_id', public.pos_custom_item_product_id(), 'name', v_custom.name, 'unit_price', v_custom.price,
      'quantity', v_custom.quantity, 'item_id', gen_random_uuid(),
      'line_discount_c', v_ld_c, 'net_c', v_gross_line_c - v_ld_c, 'is_custom', true));
  END LOOP;

  -- Order discount: taken off what is left after the line discounts, then shared across the lines
  -- (largest remainder, to the cent) so that every line still knows what was really paid for it.
  v_net_c := v_gross_c - v_line_disc_c;
  v_manual_line_c := v_line_disc_c - v_reward_c;
  v_order_disc_c := public._pos_discount_cents(p_order_discount, v_net_c);
  v_manual_c := v_order_disc_c;
  -- Staff rate: when the customer on the sale is a staff member (budtender, manager or admin), the staff percentage
  -- comes off automatically, worked out here from the database. It is not added to a manual order discount: the
  -- larger of the two applies. Nothing about it comes from the browser except which customer was attached.
  v_staff := p_customer_id IS NOT NULL AND public._is_staff(p_customer_id);
  IF v_staff THEN
    v_staff_c := round(v_net_c * public.staff_purchase_percent() / 100)::bigint;
    v_order_disc_c := GREATEST(v_manual_c, v_staff_c);
  END IF;
  -- A reward and the staff rate need no typed reason; anything typed still does.
  IF v_reason IS NULL AND v_manual_line_c = 0 AND v_manual_c = 0 AND (v_reward_c > 0 OR v_staff_c > 0) THEN
    v_reason := concat_ws(' · ',
      CASE WHEN v_reward_c > 0 THEN 'Loyalty reward' END,
      CASE WHEN v_staff_c > 0 THEN 'Staff purchase (' || regexp_replace(public.staff_purchase_percent()::text, '\.0+$', '') || '% off)' END);
  END IF;
  IF v_line_disc_c + v_order_disc_c > 0 THEN
    IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 200 THEN
      RAISE EXCEPTION 'discount_reason_required: give a reason of 3-200 characters for the discount';
    END IF;
    -- Any role may discount by any percentage up to 100% (owner decision, 28 Oct 2026), with no approval. Every
    -- discount still needs a reason and is audited. A 100% discount makes a R0 sale: it has no tenders.
  END IF;
  SELECT COALESCE(jsonb_object_agg(r.item_id::text, r.alloc), '{}'::jsonb) INTO v_oalloc
  FROM (
    SELECT q.item_id,
           q.floor_c + CASE WHEN q.rn <= (v_order_disc_c - SUM(q.floor_c) OVER ()) THEN 1 ELSE 0 END AS alloc
    FROM (
      SELECT x.product_id, x.item_id,
             COALESCE(floor(v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0)), 0)::bigint AS floor_c,
             row_number() OVER (ORDER BY COALESCE((v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0))
                                         - floor(v_order_disc_c * x.net_c::numeric / NULLIF(v_net_c, 0)), 0) DESC, x.product_id, x.item_id) AS rn
      FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, item_id uuid, net_c bigint)
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
                                discount_reason, total, idempotency_key, staff_purchase, staff_discount_rand)
  VALUES (v_sale_id, v_receipt, p_session_id, p_actor, p_customer_id, v_gross_c::numeric / 100,
          (v_line_disc_c + v_order_disc_c)::numeric / 100,
          CASE WHEN v_line_disc_c + v_order_disc_c > 0 THEN v_reason END, v_total,
          p_actor::text || ':' || p_idempotency_key, v_staff, v_staff_c::numeric / 100);

  FOR v_tender IN SELECT (t->>'method') AS method, (t->>'amount')::numeric(10,2) AS amount, (t->>'reference') AS reference
                  FROM jsonb_array_elements(p_tenders) t LOOP
    INSERT INTO public.pos_tenders (sale_id, method, amount, reference)
    VALUES (v_sale_id, v_tender.method, v_tender.amount, v_tender.reference);
  END LOOP;

  FOR v_line IN
    SELECT x.product_id, x.name, x.unit_price, x.quantity, x.item_id, x.line_discount_c, x.is_custom,
           COALESCE((v_oalloc->>(x.item_id::text))::bigint, 0) AS order_discount_c
    FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, name text, unit_price numeric, quantity numeric, item_id uuid,
                                           line_discount_c bigint, is_custom boolean)
    ORDER BY x.product_id, x.item_id
  LOOP
    INSERT INTO public.pos_sale_items (id, sale_id, product_id, product_name, unit_price_rand, quantity,
                                       line_discount_rand, order_discount_rand, line_total, is_custom)
    VALUES (v_line.item_id, v_sale_id, v_line.product_id, v_line.name, v_line.unit_price, v_line.quantity,
            v_line.line_discount_c::numeric / 100, v_line.order_discount_c::numeric / 100,
            round(v_line.unit_price * v_line.quantity, 2) - (v_line.line_discount_c + v_line.order_discount_c)::numeric / 100,
            v_line.is_custom);

    -- A custom line has no stock: nothing is allocated, so a void or refund has nothing to put back either.
    CONTINUE WHEN v_line.is_custom;
    PERFORM public._expire_holds(v_line.product_id);
    FOR v_alloc IN SELECT * FROM public._allocate_fefo(v_line.product_id, v_line.quantity) LOOP
      INSERT INTO public.inventory_ledger
        (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
      VALUES
        (v_alloc.o_batch_id, v_line.product_id, -v_alloc.o_quantity, 'POS sale ' || v_receipt,
         'pos_sale_item', v_line.item_id, p_actor, 'pos_sale');
    END LOOP;
  END LOOP;

  IF v_custom_count > 0 THEN
    PERFORM public._audit(p_actor, 'pos_custom_item_sold', 'pos_sale', v_sale_id, jsonb_build_object(
      'receipt_number', v_receipt,
      'items', (SELECT jsonb_agg(jsonb_build_object('name', i.product_name, 'unit_price', i.unit_price_rand,
                  'quantity', i.quantity, 'line_total', i.line_total) ORDER BY i.product_name)
                FROM public.pos_sale_items i WHERE i.sale_id = v_sale_id AND i.is_custom)));
  END IF;

  IF v_reward_pts > 0 THEN
    -- Points spent on the reward(s): refused (insufficient_points) if the member does not have enough.
    INSERT INTO public.loyalty_transactions (user_id, txn_type, source_type, source_id, pos_sale_id, points, balance_after)
    VALUES (p_customer_id, 'redeem', 'pos_reward', v_sale_id, v_sale_id, -v_reward_pts, 0);
  END IF;

  IF v_line_disc_c + v_order_disc_c > 0 THEN
    PERFORM public._audit(p_actor, 'pos_sale_discount', 'pos_sale', v_sale_id, jsonb_build_object(
      'receipt_number', v_receipt, 'gross', v_gross_c::numeric / 100, 'line_discounts', v_line_disc_c::numeric / 100,
      'order_discount', v_order_disc_c::numeric / 100, 'total', v_total, 'reason', v_reason,
      'staff_purchase', v_staff, 'staff_discount', v_staff_c::numeric / 100,
      'reward_points', v_reward_pts, 'reward_value', v_reward_c::numeric / 100));
  END IF;

  v_response := jsonb_build_object(
    'sale_id', v_sale_id, 'receipt_number', v_receipt, 'total', v_total, 'session_id', p_session_id,
    'subtotal', v_gross_c::numeric / 100, 'discount', (v_line_disc_c + v_order_disc_c)::numeric / 100,
    'customer_id', p_customer_id, 'staff_purchase', v_staff, 'staff_discount', v_staff_c::numeric / 100,
    'reward_points', v_reward_pts,
    'items', (SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                'quantity', i.quantity, 'unit_price', i.unit_price_rand, 'line_discount', i.line_discount_rand,
                'order_discount', i.order_discount_rand, 'line_total', i.line_total, 'is_custom', i.is_custom)
                ORDER BY i.product_name)
              FROM public.pos_sale_items i WHERE i.sale_id = v_sale_id),
    'tenders', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount, 'reference', t.reference) ORDER BY t.created_at, t.id)
                         FROM public.pos_tenders t WHERE t.sale_id = v_sale_id), '[]'::jsonb));
  RETURN public._idem_finish('pos_sale', p_actor, p_idempotency_key, v_response);
END;
$function$;

CREATE OR REPLACE FUNCTION public.pos_refund_sale(p_actor uuid, p_sale_id uuid, p_session_id uuid, p_items jsonb, p_payouts jsonb, p_reason text, p_restock boolean, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_left numeric;
  v_put numeric;
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
          OR (e->>'quantity') !~ '^(0\.[1-9]|[1-9][0-9]{0,3}(\.[0-9])?)$') THEN
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
    SELECT (e->>'sale_item_id')::uuid AS sale_item_id, SUM((e->>'quantity')::numeric) AS quantity
    FROM jsonb_array_elements(p_items) e GROUP BY 1 ORDER BY 1
  LOOP
    SELECT * INTO v_item FROM public.pos_sale_items WHERE id = v_line.sale_item_id AND sale_id = p_sale_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_items: line % is not part of this sale', v_line.sale_item_id; END IF;
    -- only a product sold by weight can be refunded in decimals (half a pre-roll would put half a unit back)
    IF v_line.quantity <> trunc(v_line.quantity) AND NOT EXISTS (
      SELECT 1 FROM public.products p WHERE p.id = v_item.product_id AND p.sold_by_weight) THEN
      RAISE EXCEPTION 'invalid_quantity: % is sold in whole units, so only whole units can be refunded', v_item.product_name;
    END IF;
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
    SELECT (e->>'sale_item_id')::uuid AS sale_item_id, SUM((e->>'quantity')::numeric) AS quantity
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
$function$;

-- 8. Reports: an online line's revenue is its rounded line total, like everywhere else.

CREATE OR REPLACE FUNCTION public.admin_overview(p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c_tz constant text := 'Africa/Johannesburg';
  v_today date := (now() AT TIME ZONE c_tz)::date;
  v_tomorrow timestamptz := ((v_today + 1)::timestamp AT TIME ZONE c_tz);
  v_today_start timestamptz := (v_today::timestamp AT TIME ZONE c_tz);
  v_week_start timestamptz := ((v_today - 6)::timestamp AT TIME ZONE c_tz);
  v_month_start timestamptz := (date_trunc('month', v_today::timestamp) AT TIME ZONE c_tz);
  v_top_start timestamptz := ((v_today - 29)::timestamp AT TIME ZONE c_tz);
  v_daily jsonb;
  v_top jsonb;
  v_counts jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');

  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', g::date, 'pos', (r->>'pos')::numeric,
                                               'online', (r->>'online')::numeric) ORDER BY g), '[]'::jsonb)
  INTO v_daily
  FROM generate_series(v_today - 6, v_today, interval '1 day') g,
       LATERAL (SELECT public._revenue_window((g::date::timestamp AT TIME ZONE c_tz),
                                              ((g::date + 1)::timestamp AT TIME ZONE c_tz))) w(r);

  -- Best sellers of the last 30 days across both channels; till revenue is the line total after discounts,
  -- pro-rated for refunded units (the same rule as Reports).
  WITH lines AS (
    SELECT i.product_name, (i.quantity - i.refunded_quantity) AS qty,
           round(i.line_total * (i.quantity - i.refunded_quantity) / i.quantity, 2) AS revenue
    FROM public.pos_sale_items i JOIN public.pos_sales s ON s.id = i.sale_id
    WHERE s.status <> 'voided' AND s.created_at >= v_top_start AND s.created_at < v_tomorrow
    UNION ALL
    SELECT i.product_name, i.quantity, round(i.unit_price_rand * i.quantity, 2)
    FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
    WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
      AND o.created_at >= v_top_start AND o.created_at < v_tomorrow
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty, 'revenue', t.revenue)
                            ORDER BY t.qty DESC, t.revenue DESC, t.name), '[]'::jsonb)
  INTO v_top
  FROM (SELECT product_name AS name, sum(qty) AS qty, sum(revenue) AS revenue
        FROM lines WHERE qty > 0 GROUP BY product_name
        ORDER BY sum(qty) DESC, sum(revenue) DESC, product_name LIMIT 5) t;

  v_counts := jsonb_build_object(
    'online_orders', (SELECT count(*) FROM public.orders WHERE archived_at IS NULL),
    'paid_online', (SELECT count(*) FROM public.orders
                    WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')),
    'till_sales', (SELECT count(*) FROM public.pos_sales WHERE status <> 'voided'),
    'customers', (SELECT count(*) FROM public.user_roles ur
                  WHERE ur.role = 'customer'
                    AND NOT EXISTS (SELECT 1 FROM public.user_roles s
                                    WHERE s.user_id = ur.user_id AND s.role IN ('budtender', 'manager', 'admin'))));

  RETURN jsonb_build_object(
    'today', public._revenue_window(v_today_start, v_tomorrow),
    'week', public._revenue_window(v_week_start, v_tomorrow),
    'month', public._revenue_window(v_month_start, v_tomorrow),
    'all_time', public._revenue_window('-infinity'::timestamptz, 'infinity'::timestamptz),
    'daily', v_daily,
    'top_products', v_top,
    'counts', v_counts);
END;
$function$;

CREATE OR REPLACE FUNCTION public._sales_report(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c_tz constant text := 'Africa/Johannesburg';
  v_start timestamptz;
  v_end timestamptz;
  v_pos jsonb;
  v_online jsonb;
  v_daily jsonb;
  v_hourly jsonb;
  v_tenders jsonb;
  v_methods jsonb;
  v_products jsonb;
  v_categories jsonb;
  v_cashiers jsonb;
  v_recent jsonb;
  v_till jsonb;
  v_sessions jsonb;
  v_expenses jsonb;
  v_pos_net numeric;
  v_online_total numeric;
  v_tx integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN
    RAISE EXCEPTION 'invalid_input: choose a date range of up to 400 days';
  END IF;
  v_start := (p_from::timestamp AT TIME ZONE c_tz);
  v_end := ((p_to + 1)::timestamp AT TIME ZONE c_tz);

  -- POS
  WITH s AS (
    SELECT * FROM public.pos_sales WHERE created_at >= v_start AND created_at < v_end
  ), r AS (
    SELECT * FROM public.pos_refunds WHERE created_at >= v_start AND created_at < v_end
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM s WHERE status <> 'voided'),
    'gross', COALESCE((SELECT sum(total) FROM s WHERE status <> 'voided'), 0),
    'before_discounts', COALESCE((SELECT sum(subtotal) FROM s WHERE status <> 'voided'), 0),
    'discounts', COALESCE((SELECT sum(discount_rand) FROM s WHERE status <> 'voided'), 0),
    'discounted_count', (SELECT count(*) FROM s WHERE status <> 'voided' AND discount_rand > 0),
    'refunds', COALESCE((SELECT sum(amount) FROM r), 0),
    'refund_count', (SELECT count(*) FROM r),
    'voided_count', (SELECT count(*) FROM s WHERE status = 'voided'),
    'voided_total', COALESCE((SELECT sum(total) FROM s WHERE status = 'voided'), 0)
  ) INTO v_pos;
  v_pos := v_pos || jsonb_build_object('net', (v_pos->>'gross')::numeric - (v_pos->>'refunds')::numeric);
  v_pos_net := (v_pos->>'net')::numeric;

  -- Online
  WITH o AS (
    SELECT * FROM public.orders WHERE created_at >= v_start AND created_at < v_end
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM o WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')),
    'total', COALESCE((SELECT sum(total_rand) FROM o WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')), 0),
    'delivery_fees', COALESCE((SELECT sum(delivery_fee_rand) FROM o WHERE status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')), 0),
    'awaiting_count', (SELECT count(*) FROM o WHERE status = 'awaiting_payment'),
    'awaiting_total', COALESCE((SELECT sum(total_rand) FROM o WHERE status = 'awaiting_payment'), 0),
    'cancelled_count', (SELECT count(*) FROM o WHERE status = 'cancelled'),
    'pickup_count', (SELECT count(*) FROM o WHERE delivery_method = 'collection'
                       AND status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed'))
  ) INTO v_online;
  v_online_total := (v_online->>'total')::numeric;
  v_tx := (v_pos->>'count')::integer + (v_online->>'count')::integer;

  -- Per day (SAST)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'pos', d.pos, 'online', d.online) ORDER BY d.day), '[]'::jsonb)
  INTO v_daily FROM (
    SELECT g::date AS day,
      COALESCE((SELECT sum(total) FROM public.pos_sales x WHERE x.status <> 'voided'
                AND (x.created_at AT TIME ZONE c_tz)::date = g::date), 0)
      - COALESCE((SELECT sum(amount) FROM public.pos_refunds x
                  WHERE (x.created_at AT TIME ZONE c_tz)::date = g::date), 0) AS pos,
      COALESCE((SELECT sum(total_rand) FROM public.orders x
                WHERE x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
                AND (x.created_at AT TIME ZONE c_tz)::date = g::date), 0) AS online
    FROM generate_series(p_from, p_to, interval '1 day') g
  ) d;

  -- Per hour of day across the range (SAST)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('hour', h.hour, 'pos', h.pos, 'online', h.online, 'count', h.n) ORDER BY h.hour), '[]'::jsonb)
  INTO v_hourly FROM (
    SELECT hr AS hour,
      COALESCE((SELECT sum(total) FROM public.pos_sales x WHERE x.status <> 'voided'
                AND x.created_at >= v_start AND x.created_at < v_end
                AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr), 0) AS pos,
      COALESCE((SELECT sum(total_rand) FROM public.orders x
                WHERE x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
                AND x.created_at >= v_start AND x.created_at < v_end
                AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr), 0) AS online,
      (SELECT count(*) FROM public.pos_sales x WHERE x.status <> 'voided'
         AND x.created_at >= v_start AND x.created_at < v_end
         AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr)
      + (SELECT count(*) FROM public.orders x
         WHERE x.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
         AND x.created_at >= v_start AND x.created_at < v_end
         AND extract(hour FROM x.created_at AT TIME ZONE c_tz) = hr) AS n
    FROM generate_series(0, 23) hr
  ) h;

  -- Till payments by method (sales not voided)
  SELECT COALESCE(jsonb_object_agg(t.method, t.amount), '{}'::jsonb) INTO v_tenders FROM (
    SELECT tn.method, sum(tn.amount) AS amount
    FROM public.pos_tenders tn JOIN public.pos_sales s ON s.id = tn.sale_id
    WHERE s.status <> 'voided' AND s.created_at >= v_start AND s.created_at < v_end
    GROUP BY tn.method) t;

  -- Online payments by method (paid orders)
  SELECT COALESCE(jsonb_object_agg(m.method, m.amount), '{}'::jsonb) INTO v_methods FROM (
    SELECT COALESCE(o.payment_method, 'unknown') AS method, sum(o.total_rand) AS amount
    FROM public.orders o
    WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
      AND o.created_at >= v_start AND o.created_at < v_end
    GROUP BY 1) m;

  -- Products (both channels; till refunds taken off). Till revenue is what was paid for the line after its
  -- discounts (line_total), pro-rated for refunded units.
  WITH lines AS (
    SELECT i.product_id, i.product_name, (i.quantity - i.refunded_quantity) AS qty,
           round(i.line_total * (i.quantity - i.refunded_quantity) / i.quantity, 2) AS revenue, 'pos' AS channel
    FROM public.pos_sale_items i JOIN public.pos_sales s ON s.id = i.sale_id
    WHERE s.status <> 'voided' AND s.created_at >= v_start AND s.created_at < v_end
    UNION ALL
    SELECT i.product_id, i.product_name, i.quantity, round(i.unit_price_rand * i.quantity, 2), 'online'
    FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
    WHERE o.status IN ('confirmed', 'packing', 'ready', 'out_for_delivery', 'completed')
      AND o.created_at >= v_start AND o.created_at < v_end
  ), by_product AS (
    SELECT l.product_name AS name, max(p.category) AS category, sum(l.qty) AS qty, sum(l.revenue) AS revenue,
           sum(l.revenue) FILTER (WHERE l.channel = 'pos') AS pos, sum(l.revenue) FILTER (WHERE l.channel = 'online') AS online
    FROM lines l LEFT JOIN public.products p ON p.id = l.product_id
    WHERE l.qty > 0
    GROUP BY l.product_name
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name', name, 'category', category, 'qty', qty, 'revenue', revenue,
                                                  'pos', COALESCE(pos, 0), 'online', COALESCE(online, 0))
                               ORDER BY revenue DESC, name)
              FROM (SELECT * FROM by_product ORDER BY revenue DESC, name LIMIT 25) t), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('category', category, 'qty', qty, 'revenue', revenue) ORDER BY revenue DESC)
              FROM (SELECT COALESCE(category, 'Other') AS category, sum(qty) AS qty, sum(revenue) AS revenue
                    FROM by_product GROUP BY 1) c), '[]'::jsonb)
  INTO v_products, v_categories;

  -- Till sales by staff member
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', c.name, 'count', c.n, 'total', c.total) ORDER BY c.total DESC), '[]'::jsonb)
  INTO v_cashiers FROM (
    SELECT COALESCE(NULLIF(btrim(pr.full_name), ''), 'Staff member') AS name, count(*) AS n, sum(s.total) AS total
    FROM public.pos_sales s LEFT JOIN public.profiles pr ON pr.id = s.cashier_id
    WHERE s.status <> 'voided' AND s.created_at >= v_start AND s.created_at < v_end
    GROUP BY 1) c;

  -- Till cash-ups: sessions CLOSED in the period (SAST)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'drawer', d.name, 'cashier', COALESCE(NULLIF(btrim(pr.full_name), ''), 'Staff member'),
      'opened_at', s.opened_at, 'closed_at', s.closed_at,
      'opening_float', s.opening_float, 'cash_sales', s.cash_sales, 'cash_refunds', s.cash_refunds,
      'expenses', s.expenses_total, 'discounts', s.discounts_total,
      'expected', s.expected_cash, 'counted', s.actual_cash, 'variance', s.variance,
      'deposited', s.cash_deposited, 'float_carried', s.float_carried,
      'approval', s.approval_status, 'approval_note', s.approval_note, 'close_note', s.close_note)
      ORDER BY s.closed_at), '[]'::jsonb)
  INTO v_sessions
  FROM public.pos_sessions s
  JOIN public.cash_drawers d ON d.id = s.drawer_id
  LEFT JOIN public.profiles pr ON pr.id = s.opened_by
  WHERE s.status = 'closed' AND s.closed_at >= v_start AND s.closed_at < v_end;

  -- Till expenses recorded in the period (not voided)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('at', e.created_at, 'category', e.category,
      'description', e.description, 'amount', e.amount,
      'by', COALESCE(NULLIF(btrim(pr.full_name), ''), 'Staff member')) ORDER BY e.created_at), '[]'::jsonb)
  INTO v_expenses
  FROM public.pos_session_expenses e LEFT JOIN public.profiles pr ON pr.id = e.created_by
  WHERE e.voided_at IS NULL AND e.created_at >= v_start AND e.created_at < v_end;

  SELECT jsonb_build_object(
    'sessions_closed', count(*),
    'opening_floats', COALESCE(sum(s.opening_float), 0),
    'cash_sales', COALESCE(sum(s.cash_sales), 0),
    'cash_refunds', COALESCE(sum(s.cash_refunds), 0),
    'expenses', COALESCE(sum(s.expenses_total), 0),
    'expected', COALESCE(sum(s.expected_cash), 0),
    'counted', COALESCE(sum(s.actual_cash), 0),
    'variance', COALESCE(sum(s.variance), 0),
    'deposited', COALESCE(sum(s.cash_deposited), 0),
    'float_carried', COALESCE(sum(s.float_carried), 0),
    'variances_pending', count(*) FILTER (WHERE s.approval_status = 'pending'))
  INTO v_till
  FROM public.pos_sessions s
  WHERE s.status = 'closed' AND s.closed_at >= v_start AND s.closed_at < v_end;
  v_till := v_till || jsonb_build_object(
    'expenses_recorded', COALESCE((SELECT sum((x->>'amount')::numeric) FROM jsonb_array_elements(v_expenses) x), 0));

  -- Latest 15 transactions, both channels (receipt / order number only)
  SELECT COALESCE(jsonb_agg(t ORDER BY t.at DESC), '[]'::jsonb) INTO v_recent FROM (
    SELECT * FROM (
      SELECT 'pos' AS channel, s.receipt_number AS ref, s.total AS amount, s.status, s.created_at AS at,
             (SELECT string_agg(DISTINCT tn.method, '+') FROM public.pos_tenders tn WHERE tn.sale_id = s.id) AS method
      FROM public.pos_sales s WHERE s.created_at >= v_start AND s.created_at < v_end
      UNION ALL
      SELECT 'online', o.order_number, o.total_rand, o.status, o.created_at, o.payment_method
      FROM public.orders o WHERE o.created_at >= v_start AND o.created_at < v_end
    ) u ORDER BY at DESC LIMIT 15) t;

  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'total', v_pos_net + v_online_total,
    'transactions', v_tx,
    'average_sale', CASE WHEN v_tx > 0 THEN round((COALESCE((v_pos->>'gross')::numeric, 0) + v_online_total) / v_tx, 2) ELSE 0 END,
    'pos', v_pos, 'online', v_online,
    'daily', v_daily, 'hourly', v_hourly,
    'pos_tenders', v_tenders, 'online_methods', v_methods,
    'products', v_products, 'categories', v_categories,
    'cashiers', v_cashiers, 'recent', v_recent,
    'till', v_till, 'till_sessions', v_sessions, 'expenses', v_expenses);
END;
$function$;

-- 9. The two views, exactly as before except that stock is no longer cast to whole numbers.
CREATE VIEW public.inventory_availability WITH (security_invoker = on) AS
 SELECT p.id AS product_id,
    COALESCE(sum(b.qty_on_hand) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()), 0) AS on_hand,
    COALESCE(sum(b.qty_held) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()), 0) AS held,
    COALESCE(sum(b.qty_on_hand - b.qty_held) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()), 0) AS available,
    COALESCE(sum(b.qty_on_hand) FILTER (WHERE b.expires_at IS NOT NULL AND b.expires_at <= now()), 0) AS expired,
    COALESCE(( SELECT - sum(l.quantity_delta)
           FROM inventory_ledger l
          WHERE l.product_id = p.id AND (l.movement_type = ANY (ARRAY['online_sale'::text, 'pos_sale'::text, 'online_cancel_restock'::text, 'pos_void_restock'::text, 'pos_refund_restock'::text]))), 0) AS consumed,
    count(b.id)::integer AS batches
   FROM products p
     LEFT JOIN inventory_batches b ON b.product_id = p.id
  GROUP BY p.id;
CREATE VIEW public.stock_movements WITH (security_invoker = on) AS
 SELECT id,
    batch_id,
    product_id,
    movement_type,
    quantity_delta,
    reason,
    reference_type,
    reference_id,
    actor_user_id,
    created_at
   FROM inventory_ledger;
REVOKE ALL ON public.inventory_availability, public.stock_movements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_availability, public.stock_movements TO authenticated;
GRANT ALL ON public.inventory_availability, public.stock_movements TO service_role;

-- 10. Plug matching returns stock as numbers too (it reads the view above).
DROP FUNCTION IF EXISTS public.plug_match_candidates(text[]);
CREATE OR REPLACE FUNCTION public.plug_match_candidates(p_categories text[] DEFAULT NULL::text[])
 RETURNS TABLE(id uuid, name text, category text, subcategory text, strain_type text, price_rand numeric, regular_price_rand numeric, unit text, image_path text, is_featured boolean, sort_order integer, available numeric, units_7d numeric, fast_seller boolean, buffer integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH s AS (SELECT * FROM public.plug_settings WHERE id),
       v AS (SELECT * FROM public._plug_units_7d())
  SELECT p.id, p.name, p.category, p.subcategory, p.strain_type, p.price_rand, p.regular_price_rand, p.unit,
         p.image_path, p.is_featured, p.sort_order, a.available,
         COALESCE(v.units, 0) AS units_7d,
         COALESCE(v.units, 0) >= s.fast_seller_units_7d AS fast_seller,
         CASE WHEN COALESCE(v.units, 0) >= s.fast_seller_units_7d THEN s.buffer_fast ELSE s.buffer_default END
  FROM public.products p
  JOIN public.inventory_availability a ON a.product_id = p.id
  CROSS JOIN s
  LEFT JOIN v ON v.product_id = p.id
  WHERE p.is_active AND p.sell_online AND NOT p.requires_recommendation
    AND p.price_rand > 0
    AND (p_categories IS NULL OR p.category = ANY (p_categories))
    AND a.available >= GREATEST(
          CASE WHEN COALESCE(v.units, 0) >= s.fast_seller_units_7d THEN s.buffer_fast ELSE s.buffer_default END, 1);
$function$;

-- 11. Dropped functions come back with the same grants as before: the service role only.
REVOKE EXECUTE ON FUNCTION public._allocate_fefo(uuid, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._allocate_fefo(uuid, numeric) TO service_role;
REVOKE EXECUTE ON FUNCTION public._product_on_hand(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._product_on_hand(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public._product_available(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._product_available(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public._plug_units_7d() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._plug_units_7d() TO service_role;
REVOKE EXECUTE ON FUNCTION public._purchased_today(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._purchased_today(uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public._reserve_order_items(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reserve_order_items(uuid, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public._sale_step(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._sale_step(uuid) TO service_role;
REVOKE EXECUTE ON FUNCTION public._stock_move_product(uuid, uuid, numeric, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._stock_move_product(uuid, uuid, numeric, text, text, uuid, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.adjust_stock(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_stock(uuid, uuid, numeric, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.receive_stock(uuid, uuid, text, numeric, timestamp with time zone, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receive_stock(uuid, uuid, text, numeric, timestamp with time zone, numeric, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stock_quick_adjust(uuid, uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_quick_adjust(uuid, uuid, numeric, text, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.stock_take_record_count(uuid, uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_take_record_count(uuid, uuid, uuid, numeric, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.plug_match_candidates(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plug_match_candidates(text[]) TO service_role;

DO $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
      ('20261127003000', '20261127003000_decimal_stock')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

COMMIT;

-- Check (should show: numeric, numeric, true, false, 2):
SELECT (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'inventory_batches' AND column_name = 'qty_on_hand') AS stock_column,
       (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'quantity') AS order_column,
       to_regprocedure('public._assert_stock_qty(uuid,numeric)') IS NOT NULL AS stock_check_ready,
       has_function_privilege('authenticated', 'public.receive_stock(uuid,uuid,text,numeric,timestamp with time zone,numeric,text,text)', 'EXECUTE') AS browsers_can_receive,
       (SELECT count(*) FROM pg_class WHERE relname IN ('inventory_availability', 'stock_movements') AND relkind = 'v') AS views;
