-- Rollback for 20261029004000_rewards_referrals: puts back the previous functions, the old earning rate (R10 per point)
-- and tier thresholds, and removes usernames, referrals and the rewards catalogue. Refused once any of it has been used
-- (a reward redeemed, a referral recorded, a point conversion, or a username chosen): that data would be lost, and
-- the points conversion cannot be undone. Revert the code and keep the migration instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions
             WHERE source_type IN ('pos_reward', 'pos_reward_void', 'referral', 'points_conversion'))
     OR EXISTS (SELECT 1 FROM public.referrals)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE username IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback_blocked: rewards, referrals, usernames or a points conversion exist; keep this migration';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._loyalty_apply_txn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account public.loyalty_accounts;
  v_balance integer;
  v_lifetime integer;
  v_tier uuid;
BEGIN
  PERFORM set_config('cannaplug.loyalty_write', 'on', true);
  INSERT INTO public.loyalty_accounts (user_id) VALUES (NEW.user_id) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_account FROM public.loyalty_accounts WHERE user_id = NEW.user_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
             WHERE t.source_type = NEW.source_type AND t.source_id = NEW.source_id) THEN
    PERFORM set_config('cannaplug.loyalty_write', 'off', true);
    RETURN NULL;
  END IF;

  IF NEW.txn_type = 'redeem' AND v_account.points_balance + NEW.points < 0 THEN
    RAISE EXCEPTION 'insufficient_points: balance is % points', v_account.points_balance;
  END IF;

  v_balance := v_account.points_balance + NEW.points;
  -- Lifetime points (which decide the tier) follow earning and its reversals, never spending.
  v_lifetime := GREATEST(v_account.lifetime_points
    + CASE WHEN NEW.source_type IN ('order', 'order_cancel', 'pos_sale', 'pos_sale_void', 'pos_refund')
           THEN NEW.points ELSE 0 END, 0);
  SELECT t.id INTO v_tier FROM public.loyalty_tiers t
  WHERE t.is_active AND t.min_lifetime_points <= v_lifetime
  ORDER BY t.min_lifetime_points DESC LIMIT 1;

  UPDATE public.loyalty_accounts
  SET points_balance = v_balance, lifetime_points = v_lifetime, tier_id = v_tier, updated_at = now()
  WHERE user_id = NEW.user_id;
  PERFORM set_config('cannaplug.loyalty_write', 'off', true);

  NEW.balance_after := v_balance;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.accrue_pos_loyalty(p_sale_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sale public.pos_sales;
  v_net numeric(10,2);
  v_points integer;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('accrued', false, 'reason', 'sale_not_found'); END IF;
  IF v_sale.customer_id IS NULL THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_customer'); END IF;
  IF v_sale.status = 'voided' THEN RETURN jsonb_build_object('accrued', false, 'reason', 'voided'); END IF;
  SELECT v_sale.total - COALESCE(SUM(r.amount), 0) INTO v_net FROM public.pos_refunds r WHERE r.sale_id = p_sale_id;
  v_points := public._loyalty_points_for_amount(v_net);
  IF v_points <= 0 THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_points'); END IF;
  INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
  VALUES (v_sale.customer_id, p_sale_id, 'pos_sale', p_sale_id, v_points)
  ON CONFLICT (source_type, source_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('accrued', true, 'points', v_points);
  END IF;
  RETURN jsonb_build_object('accrued', false, 'reason', 'already_accrued');
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

CREATE OR REPLACE FUNCTION public.pos_void_sale(p_actor uuid, p_sale_id uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_sale public.pos_sales;
  v_session public.pos_sessions;
  v_batches uuid[];
  v_mv record;
  v_current integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('pos_void', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_sale_id, 'r', p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-500 characters is mandatory';
  END IF;

  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale_not_found'; END IF;
  IF v_sale.status <> 'completed' THEN
    RAISE EXCEPTION 'invalid_sale_state: only completed, unrefunded sales can be voided (%)', v_sale.status;
  END IF;
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = v_sale.session_id FOR SHARE;
  IF v_session.status <> 'open' THEN
    RAISE EXCEPTION 'session_closed: the sale''s till session is closed; issue a refund instead';
  END IF;

  SELECT array_agg(DISTINCT l.batch_id) INTO v_batches
  FROM public.inventory_ledger l
  JOIN public.pos_sale_items i ON i.id = l.reference_id AND l.reference_type = 'pos_sale_item'
  WHERE i.sale_id = p_sale_id AND l.movement_type = 'pos_sale';
  PERFORM public._lock_batches(v_batches);

  FOR v_mv IN
    SELECT l.batch_id, l.product_id, -l.quantity_delta AS qty, l.reference_id
    FROM public.inventory_ledger l
    JOIN public.pos_sale_items i ON i.id = l.reference_id AND l.reference_type = 'pos_sale_item'
    WHERE i.sale_id = p_sale_id AND l.movement_type = 'pos_sale'
    ORDER BY l.product_id, l.batch_id, l.id
  LOOP
    INSERT INTO public.inventory_ledger
      (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
    VALUES
      (v_mv.batch_id, v_mv.product_id, v_mv.qty, 'POS void ' || v_sale.receipt_number,
       'pos_sale_item', v_mv.reference_id, p_actor, 'pos_void_restock');
  END LOOP;

  UPDATE public.pos_sales
  SET status = 'voided', voided_at = now(), voided_by = p_actor, void_reason = btrim(p_reason)
  WHERE id = p_sale_id;

  -- No TOCTOU here: this transaction holds the pos_sales row FOR UPDATE and accrue_pos_loyalty must
  -- take the same lock first, so accrual cannot interleave between this read and the insert below.
  SELECT COALESCE(SUM(points), 0) INTO v_current FROM public.loyalty_ledger WHERE sale_id = p_sale_id;
  IF v_current > 0 THEN
    INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
    VALUES (v_sale.customer_id, p_sale_id, 'pos_sale_void', p_sale_id, -v_current)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;

  PERFORM public._audit(p_actor, 'pos_sale_voided', 'pos_sale', p_sale_id,
    jsonb_build_object('receipt', v_sale.receipt_number, 'total', v_sale.total, 'reason', btrim(p_reason),
                       'session_id', v_sale.session_id, 'loyalty_reversed', v_current));
  v_response := jsonb_build_object('sale_id', p_sale_id, 'status', 'voided', 'loyalty_reversed', v_current);
  RETURN public._idem_finish('pos_void', p_actor, p_idempotency_key, v_response);
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
  v_staff boolean := false;
  v_manual_c bigint := 0;
  v_staff_c bigint := 0;
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
  -- Who may be attached as a staff customer (and so get the staff rate): see _pos_can_attach_staff.
  IF p_customer_id IS NOT NULL AND public._is_staff(p_customer_id)
     AND NOT public._pos_can_attach_staff(p_actor, p_customer_id) THEN
    RAISE EXCEPTION 'staff_attach_not_allowed: managers and admins can attach any staff member; a budtender can attach other budtenders, but not themselves';
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
  v_manual_c := v_order_disc_c;
  -- Staff rate: when the customer on the sale is a staff member (budtender, manager or admin), the staff percentage
  -- comes off automatically, worked out here from the database. It is not added to a manual order discount: the
  -- larger of the two applies. Nothing about it comes from the browser except which customer was attached.
  v_staff := p_customer_id IS NOT NULL AND public._is_staff(p_customer_id);
  IF v_staff THEN
    v_staff_c := round(v_net_c * public.staff_purchase_percent() / 100)::bigint;
    v_order_disc_c := GREATEST(v_manual_c, v_staff_c);
    IF v_reason IS NULL AND v_line_disc_c = 0 AND v_manual_c = 0 AND v_staff_c > 0 THEN
      v_reason := 'Staff purchase (' || regexp_replace(public.staff_purchase_percent()::text, '\.0+$', '') || '% off)';
    END IF;
  END IF;
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
      'order_discount', v_order_disc_c::numeric / 100, 'total', v_total, 'reason', v_reason,
      'staff_purchase', v_staff, 'staff_discount', v_staff_c::numeric / 100));
  END IF;

  v_response := jsonb_build_object(
    'sale_id', v_sale_id, 'receipt_number', v_receipt, 'total', v_total, 'session_id', p_session_id,
    'subtotal', v_gross_c::numeric / 100, 'discount', (v_line_disc_c + v_order_disc_c)::numeric / 100,
    'customer_id', p_customer_id, 'staff_purchase', v_staff, 'staff_discount', v_staff_c::numeric / 100,
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

CREATE OR REPLACE FUNCTION public.pos_customer_search(p_actor uuid, p_search text, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_q text := NULLIF(btrim(COALESCE(p_search, '')), '');
  v_pat text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 6), 1), 20);
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF v_q IS NULL OR length(v_q) < 2 OR length(v_q) > 100 THEN RETURN '[]'::jsonb; END IF;
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', x.id, 'full_name', x.full_name, 'phone', x.phone, 'email', x.email,
                                        'is_staff', x.is_staff, 'can_attach', x.can_attach, 'blocked_reason', x.blocked_reason) ORDER BY x.is_staff, x.full_name NULLS LAST, x.id)
    FROM (
      SELECT u.id, p.full_name, p.phone, u.email, public._is_staff(u.id) AS is_staff,
             (NOT public._is_staff(u.id) OR public._pos_can_attach_staff(p_actor, u.id)) AS can_attach,
             CASE WHEN NOT public._is_staff(u.id) OR public._pos_can_attach_staff(p_actor, u.id) THEN NULL
                  WHEN u.id = p_actor THEN 'You cannot give yourself the staff rate on your own till sale'
                  ELSE 'Only a manager or admin can attach this staff member' END AS blocked_reason
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
      WHERE EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id)
        AND (p.full_name ILIKE v_pat OR p.phone ILIKE v_pat OR u.email ILIKE v_pat)
      ORDER BY p.full_name NULLS LAST, u.id
      LIMIT v_limit) x), '[]'::jsonb);
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_customer_search(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_customer_search(uuid, text, integer) TO service_role;

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
  -- A staff rate already took its share off the goods; points apply to what is left.
  v_subtotal := v_subtotal - v_order.staff_discount_rand;
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

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id text := upper(regexp_replace(COALESCE(NEW.raw_user_meta_data ->> 'id_number', ''), '[\s-]', '', 'g'));
  v_ref text := upper(btrim(COALESCE(NEW.raw_user_meta_data ->> 'referral_code', '')));
BEGIN
  INSERT INTO public.profiles (id, full_name, first_name, last_name, phone, date_of_birth, address)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'first_name', '')), ''),
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')), ''),
    NEW.raw_user_meta_data ->> 'phone',
    NULLIF(NEW.raw_user_meta_data ->> 'date_of_birth', '')::date,
    NEW.raw_user_meta_data ->> 'address'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'customer'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  IF v_id ~ '^[A-Z0-9]{6,20}$' OR v_ref ~ '^[A-Z0-9-]{3,32}$' THEN
    INSERT INTO public.member_signup_details (user_id, id_number, referral_code)
    VALUES (NEW.id,
            CASE WHEN v_id ~ '^[A-Z0-9]{6,20}$' THEN v_id END,
            CASE WHEN v_ref ~ '^[A-Z0-9-]{3,32}$' THEN v_ref END)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF NEW.raw_user_meta_data ? 'id_number' OR NEW.raw_user_meta_data ? 'referral_code' THEN
    UPDATE auth.users
    SET raw_user_meta_data = raw_user_meta_data - 'id_number' - 'referral_code'
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

UPDATE public.loyalty_rules SET value = 10, updated_at = now() WHERE code = 'earn_rand_per_point';
UPDATE public.loyalty_tiers SET
  min_lifetime_points = CASE code WHEN 'sprout' THEN 500 WHEN 'bloom' THEN 2000 WHEN 'canopy' THEN 5000 ELSE min_lifetime_points END,
  perks = CASE code WHEN 'seed' THEN ARRAY['Earn 1 point per R10 spent'] ELSE perks END;

DROP FUNCTION IF EXISTS public.member_rewards_summary(uuid);
DROP FUNCTION IF EXISTS public.pos_customer_rewards(uuid, uuid);
DROP FUNCTION IF EXISTS public._reward_eligible(text, uuid);
DROP TABLE IF EXISTS public.loyalty_rewards;
DROP FUNCTION IF EXISTS public._referral_check(uuid);
DROP FUNCTION IF EXISTS public.referral_code_check(text);
DROP TABLE IF EXISTS public.referrals;
DROP FUNCTION IF EXISTS public._referral_eligible(uuid);
DROP FUNCTION IF EXISTS public.referral_min_spend();
DROP FUNCTION IF EXISTS public.referral_points();
DROP FUNCTION IF EXISTS public.member_set_username(uuid, text, text);
DROP FUNCTION IF EXISTS public.username_check(text);
DROP FUNCTION IF EXISTS public._username_reserved(text);
DROP INDEX IF EXISTS public.profiles_username_uidx;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_format;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS username;
