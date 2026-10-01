-- Rollback for Milestone 4 (20260930001000_member_account_live.sql).
-- DESTROYS loyalty accounts/transactions, wishlists and back-in-stock subscriptions created since the
-- migration. The pre-existing POS loyalty_ledger is untouched and remains the source of POS points.
-- Run only on a database where the migration was applied; objects are dropped IF EXISTS so a partial
-- apply can also be unwound.

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['orders', 'order_status_history', 'loyalty_accounts', 'loyalty_transactions'] LOOP
      IF EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        -- orders / order_status_history were not in the publication before M4 on a fresh project;
        -- on hosted projects that already published them, re-add them manually if needed.
        EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS orders_loyalty_on_status ON public.orders;
DROP TRIGGER IF EXISTS loyalty_ledger_mirror ON public.loyalty_ledger;

-- Restore the Milestone 3 POS functions exactly as they were.
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
  v_points := floor(v_net / 10)::integer;
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
    v_amount := v_amount + v_item.unit_price_rand * v_line.quantity;
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
    v_target := floor((v_sale.total - (SELECT COALESCE(SUM(r.amount), 0) FROM public.pos_refunds r WHERE r.sale_id = p_sale_id)) / 10)::integer;
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

DROP FUNCTION IF EXISTS public.create_reorder(uuid, uuid, numeric, text);
DROP FUNCTION IF EXISTS public.reorder_check(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_back_in_stock_notifications(integer);
DROP FUNCTION IF EXISTS public.redeem_loyalty_points(uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public._orders_loyalty_trigger();
DROP FUNCTION IF EXISTS public.reverse_order_loyalty(uuid);
DROP FUNCTION IF EXISTS public.accrue_order_loyalty(uuid);
DROP FUNCTION IF EXISTS public._loyalty_ledger_mirror();

DROP TABLE IF EXISTS public.back_in_stock_subscriptions;
DROP TABLE IF EXISTS public.wishlist_items;
DROP TABLE IF EXISTS public.loyalty_transactions;
DROP TABLE IF EXISTS public.loyalty_accounts;
DROP TABLE IF EXISTS public.loyalty_rules;
DROP TABLE IF EXISTS public.loyalty_tiers;

-- Put the legacy (empty, unused) table back under its original name if the migration moved it aside.
DO $$
BEGIN
  IF to_regclass('public.loyalty_transactions_legacy') IS NOT NULL
     AND to_regclass('public.loyalty_transactions') IS NULL THEN
    ALTER TABLE public.loyalty_transactions_legacy RENAME TO loyalty_transactions;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loyalty_transactions_legacy_pkey') THEN
      ALTER TABLE public.loyalty_transactions RENAME CONSTRAINT loyalty_transactions_legacy_pkey TO loyalty_transactions_pkey;
    END IF;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public._back_in_stock_guard();
DROP FUNCTION IF EXISTS public._wishlist_guard();
DROP FUNCTION IF EXISTS public._product_available(uuid);
DROP FUNCTION IF EXISTS public._loyalty_apply_txn();
DROP FUNCTION IF EXISTS public._loyalty_account_guard();
DROP FUNCTION IF EXISTS public._loyalty_points_for_amount(numeric);
DROP FUNCTION IF EXISTS public._loyalty_rule(text);

ALTER TABLE public.orders
  DROP COLUMN IF EXISTS loyalty_points_redeemed,
  DROP COLUMN IF EXISTS loyalty_discount_rand;
COMMENT ON COLUMN public.orders.total_rand IS NULL;

-- Order timeline: back to staff-only table-level reads.
DROP POLICY IF EXISTS "own order status history" ON public.order_status_history;
REVOKE SELECT ON public.order_status_history FROM authenticated;
GRANT SELECT ON public.order_status_history TO authenticated;

-- Addresses: restore the Milestone 1 column-level client write grants.
GRANT INSERT (
  user_id, label, recipient_name, phone, line1, line2, suburb, city,
  province, postal_code, country, delivery_notes, is_default
) ON public.addresses TO authenticated;
GRANT UPDATE (
  label, recipient_name, phone, line1, line2, suburb, city, province,
  postal_code, country, delivery_notes, is_default, updated_at
) ON public.addresses TO authenticated;
GRANT DELETE ON public.addresses TO authenticated;

DROP FUNCTION IF EXISTS public.member_delete_address(uuid, uuid);
DROP FUNCTION IF EXISTS public.member_set_default_address(uuid, uuid);
DROP FUNCTION IF EXISTS public.member_save_address(uuid, uuid, jsonb, boolean);
