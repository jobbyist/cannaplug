-- Rollback for 20261027005000_online_only_sales: sales apply at the till again; the column goes.
DROP TRIGGER IF EXISTS products_clear_online_only ON public.products;
DROP FUNCTION IF EXISTS public._products_clear_online_only();
CREATE OR REPLACE FUNCTION public.products_end_expired_sales(p_actor uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  END IF;
  WITH due AS (
    SELECT id, price_rand AS sale_price, regular_price_rand AS regular_price, sale_ends_at
    FROM public.products
    WHERE sale_ends_at IS NOT NULL AND sale_ends_at <= now() AND regular_price_rand IS NOT NULL
    FOR UPDATE SKIP LOCKED
  ), ended AS (
    UPDATE public.products p
    SET price_rand = due.regular_price, regular_price_rand = NULL, sale_ends_at = NULL
    FROM due
    WHERE p.id = due.id
    RETURNING p.id, due.sale_price, due.regular_price, due.sale_ends_at
  ), logged AS (
    INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    SELECT p_actor, 'product_sale_ended', 'product', e.id,
           jsonb_build_object('sale_price', e.sale_price, 'regular_price', e.regular_price,
                              'sale_ended_at', e.sale_ends_at, 'by', CASE WHEN p_actor IS NULL THEN 'scheduler' ELSE 'staff' END)
    FROM ended e
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM logged;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.products_end_expired_sales(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.products_end_expired_sales(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.pos_complete_sale(
  p_actor uuid,
  p_session_id uuid,
  p_items jsonb,
  p_tenders jsonb,
  p_customer_id uuid,
  p_idempotency_key text
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
    jsonb_build_object('session', p_session_id, 'items', p_items, 'tenders', p_tenders, 'customer', p_customer_id));
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
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
    ORDER BY 1
  LOOP
    SELECT p.name, p.price_rand INTO v_name, v_price
    FROM public.products p WHERE p.id = v_line.product_id AND p.is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'product_unavailable: %', v_line.product_id; END IF;
    v_total := v_total + v_price * v_line.quantity;
    v_priced := v_priced || jsonb_build_array(jsonb_build_object(
      'product_id', v_line.product_id, 'name', v_name, 'unit_price', v_price,
      'quantity', v_line.quantity, 'item_id', gen_random_uuid()));
  END LOOP;

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
  INSERT INTO public.pos_sales (id, receipt_number, session_id, cashier_id, customer_id, subtotal, total, idempotency_key)
  VALUES (v_sale_id, v_receipt, p_session_id, p_actor, p_customer_id, v_total, v_total,
          p_actor::text || ':' || p_idempotency_key);

  FOR v_tender IN SELECT (t->>'method') AS method, (t->>'amount')::numeric(10,2) AS amount, (t->>'reference') AS reference
                  FROM jsonb_array_elements(p_tenders) t LOOP
    INSERT INTO public.pos_tenders (sale_id, method, amount, reference)
    VALUES (v_sale_id, v_tender.method, v_tender.amount, v_tender.reference);
  END LOOP;

  FOR v_line IN
    SELECT x.product_id, x.name, x.unit_price, x.quantity, x.item_id
    FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, name text, unit_price numeric, quantity integer, item_id uuid)
    ORDER BY x.product_id
  LOOP
    INSERT INTO public.pos_sale_items (id, sale_id, product_id, product_name, unit_price_rand, quantity, line_total)
    VALUES (v_line.item_id, v_sale_id, v_line.product_id, v_line.name, v_line.unit_price, v_line.quantity,
            v_line.unit_price * v_line.quantity);

    PERFORM public._expire_holds(v_line.product_id);
    FOR v_alloc IN SELECT * FROM public._allocate_fefo(v_line.product_id, v_line.quantity) LOOP
      INSERT INTO public.inventory_ledger
        (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
      VALUES
        (v_alloc.o_batch_id, v_line.product_id, -v_alloc.o_quantity, 'POS sale ' || v_receipt,
         'pos_sale_item', v_line.item_id, p_actor, 'pos_sale');
    END LOOP;
  END LOOP;

  v_response := jsonb_build_object(
    'sale_id', v_sale_id, 'receipt_number', v_receipt, 'total', v_total, 'session_id', p_session_id,
    'customer_id', p_customer_id,
    'items', (SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                'quantity', i.quantity, 'unit_price', i.unit_price_rand, 'line_total', i.line_total) ORDER BY i.product_name)
              FROM public.pos_sale_items i WHERE i.sale_id = v_sale_id),
    'tenders', (SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount, 'reference', t.reference) ORDER BY t.created_at, t.id)
                FROM public.pos_tenders t WHERE t.sale_id = v_sale_id));
  RETURN public._idem_finish('pos_sale', p_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text) TO service_role;

ALTER TABLE public.products DROP COLUMN IF EXISTS sale_online_only;
