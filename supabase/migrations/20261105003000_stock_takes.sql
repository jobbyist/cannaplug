-- 5 Nov 2026: a real stock-management workflow (staff feedback: "we need an actual stock management system where we
-- can add and remove stock as needed, count it, and add new stock as it comes in easily"). Until now staff could only
-- receive or adjust one batch at a time. This adds, on top of the existing batch + ledger engine (nothing about how
-- stock is stored changes; every movement is still an inventory_ledger row):
--
--   * Stock takes. A manager starts a count (whole shop or one category); staff count products one by one, each
--     count saving what the system showed at that moment (expected_at_count); a manager reviews the differences
--     and posts them in one transaction, or cancels. Posting applies counted - expected_at_count, so sales made
--     after a product was counted are not undone. Only one count can be open at a time.
--   * Product-level quick add / remove (stock_quick_adjust): staff never pick a batch. Removals come out of the
--     first-expiring batches (never below what online orders are holding); additions go to the newest batch.
--   * Delivery receiving (stock_receive_delivery): many products in one go, with supplier name and reference,
--     all-or-nothing.
--
-- All functions: SECURITY DEFINER, search_path '', explicit actor, idempotency key, audit row, service role only.
-- New tables have RLS: staff (budtender and up) can read; browsers cannot write.

CREATE TABLE IF NOT EXISTS public.stock_takes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'posted', 'cancelled')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  category text CHECK (category IS NULL OR length(category) BETWEEN 1 AND 80),
  started_by uuid NOT NULL REFERENCES auth.users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES auth.users(id),
  closed_at timestamptz,
  CONSTRAINT stock_takes_closed_chk CHECK ((status = 'open') = (closed_at IS NULL))
);
-- One open count at a time, so two counts can never post over each other.
CREATE UNIQUE INDEX IF NOT EXISTS stock_takes_one_open_uidx ON public.stock_takes ((true)) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS stock_takes_started_idx ON public.stock_takes (started_at DESC);

CREATE TABLE IF NOT EXISTS public.stock_take_lines (
  stock_take_id uuid NOT NULL REFERENCES public.stock_takes(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  expected_at_count integer NOT NULL CHECK (expected_at_count >= 0),
  counted_qty integer NOT NULL CHECK (counted_qty BETWEEN 0 AND 1000000),
  counted_by uuid NOT NULL REFERENCES auth.users(id),
  counted_at timestamptz NOT NULL DEFAULT now(),
  posted_delta integer,
  PRIMARY KEY (stock_take_id, product_id)
);

ALTER TABLE public.stock_takes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_take_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_takes, public.stock_take_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.stock_takes, public.stock_take_lines TO authenticated;
GRANT ALL ON public.stock_takes, public.stock_take_lines TO service_role;
DROP POLICY IF EXISTS "staff read stock takes" ON public.stock_takes;
CREATE POLICY "staff read stock takes"
ON public.stock_takes FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));
DROP POLICY IF EXISTS "staff read stock take lines" ON public.stock_take_lines;
CREATE POLICY "staff read stock take lines"
ON public.stock_take_lines FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));

-- What the system shows on hand for a product right now (all batches, expired included: they are on the shelf).
CREATE OR REPLACE FUNCTION public._product_on_hand(p_product_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(sum(b.qty_on_hand), 0)::integer FROM public.inventory_batches b WHERE b.product_id = p_product_id;
$$;

-- Moves a product's stock by p_delta without the caller choosing batches. Removals take from the first-expiring
-- batches, never below what online orders hold; additions go to the newest batch (or a new dated batch when the
-- product has none). Callers check the role and own the idempotency and audit. Returns before / after.
CREATE OR REPLACE FUNCTION public._stock_move_product(
  p_actor uuid,
  p_product_id uuid,
  p_delta integer,
  p_reason text,
  p_reference_type text,
  p_reference_id uuid,
  p_new_batch_prefix text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[];
  v_before integer;
  v_remaining integer;
  v_avail integer;
  v_take integer;
  v_batch uuid;
  v_name text;
  v_code text;
  r record;
BEGIN
  SELECT p.name INTO v_name FROM public.products p WHERE p.id = p_product_id;
  IF v_name IS NULL THEN RAISE EXCEPTION 'product_unavailable: %', p_product_id; END IF;
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
$$;

CREATE OR REPLACE FUNCTION public.stock_quick_adjust(
  p_actor uuid,
  p_product_id uuid,
  p_delta integer,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.stock_receive_delivery(
  p_actor uuid,
  p_supplier text,
  p_reference text,
  p_lines jsonb,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_delivery uuid := gen_random_uuid();
  v_supplier text := NULLIF(btrim(COALESCE(p_supplier, '')), '');
  v_ref text := NULLIF(upper(regexp_replace(btrim(COALESCE(p_reference, '')), '[^A-Za-z0-9-]+', '-', 'g')), '');
  v_code text;
  v_line jsonb;
  v_product uuid;
  v_qty integer;
  v_cost numeric;
  v_expires timestamptz;
  v_batch uuid;
  v_seen uuid[] := ARRAY[]::uuid[];
  v_units integer := 0;
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
      v_qty := (v_line ->> 'quantity')::integer;
      v_cost := NULLIF(v_line ->> 'unit_cost', '')::numeric;
      v_expires := NULLIF(v_line ->> 'expires_at', '')::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_lines: a line has a value that is not a number or a date';
    END;
    IF v_product IS NULL THEN RAISE EXCEPTION 'invalid_lines: a line has no product'; END IF;
    IF v_product = ANY (v_seen) THEN RAISE EXCEPTION 'duplicate_product: each product can appear once per delivery'; END IF;
    v_seen := v_seen || v_product;
    IF v_qty IS NULL OR v_qty NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
    IF v_cost IS NOT NULL AND (v_cost < 0 OR v_cost <> round(v_cost, 2)) THEN RAISE EXCEPTION 'invalid_unit_cost'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = v_product) THEN
      RAISE EXCEPTION 'product_unavailable: %', v_product;
    END IF;

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
$$;

CREATE OR REPLACE FUNCTION public.stock_take_start(
  p_actor uuid,
  p_note text,
  p_category text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_id uuid;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('stock_take_start', p_actor, p_idempotency_key,
    jsonb_build_object('n', p_note, 'c', p_category));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF EXISTS (SELECT 1 FROM public.stock_takes t WHERE t.status = 'open') THEN
    RAISE EXCEPTION 'stock_take_open: finish or cancel the count that is already open';
  END IF;
  INSERT INTO public.stock_takes (note, category, started_by)
  VALUES (NULLIF(left(btrim(COALESCE(p_note, '')), 300), ''), NULLIF(btrim(COALESCE(p_category, '')), ''), p_actor)
  RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'stock_take_started', 'stock_take', v_id,
    jsonb_build_object('category', NULLIF(btrim(COALESCE(p_category, '')), '')));
  RETURN public._idem_finish('stock_take_start', p_actor, p_idempotency_key, jsonb_build_object('stock_take_id', v_id));
END;
$$;

CREATE OR REPLACE FUNCTION public.stock_take_record_count(
  p_actor uuid,
  p_stock_take_id uuid,
  p_product_id uuid,
  p_counted integer,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_take public.stock_takes;
  v_category text;
  v_ids uuid[];
  v_expected integer;
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
$$;

CREATE OR REPLACE FUNCTION public.stock_take_post(
  p_actor uuid,
  p_stock_take_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_take public.stock_takes;
  v_delta integer;
  v_lines integer := 0;
  v_changed integer := 0;
  v_over integer := 0;
  v_under integer := 0;
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
$$;

CREATE OR REPLACE FUNCTION public.stock_take_cancel(
  p_actor uuid,
  p_stock_take_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_status text;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('stock_take_cancel', p_actor, p_idempotency_key, jsonb_build_object('t', p_stock_take_id));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT t.status INTO v_status FROM public.stock_takes t WHERE t.id = p_stock_take_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_take_not_found'; END IF;
  IF v_status <> 'open' THEN RAISE EXCEPTION 'stock_take_closed: this count has already been posted or cancelled'; END IF;
  UPDATE public.stock_takes SET status = 'cancelled', closed_by = p_actor, closed_at = now() WHERE id = p_stock_take_id;
  PERFORM public._audit(p_actor, 'stock_take_cancelled', 'stock_take', p_stock_take_id, '{}'::jsonb);
  RETURN public._idem_finish('stock_take_cancel', p_actor, p_idempotency_key,
    jsonb_build_object('stock_take_id', p_stock_take_id, 'status', 'cancelled'));
END;
$$;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY['_product_on_hand', '_stock_move_product', 'stock_quick_adjust',
                                 'stock_receive_delivery', 'stock_take_start', 'stock_take_record_count',
                                 'stock_take_post', 'stock_take_cancel'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;
