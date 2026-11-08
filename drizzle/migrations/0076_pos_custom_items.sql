-- 8 Nov 2026: custom items at the till (client request). A cashier can ring up something that is not in the product
-- list (a one-off item, a service, a special order) by typing its name and price. It applies to that sale only and is
-- never added to the product list.
--
--   * A custom line is stored on the sale (pos_sale_items, is_custom = true) with the typed name and price, so the
--     receipt, reports, voids and refunds work as for any line. Every sale line needs a product id, so custom lines
--     point at one hidden placeholder product (fixed id below, inactive, untracked, never sold online, hidden from
--     the shop, the till search and every admin list, and locked against any change). Nothing is ever created per
--     custom item.
--   * Custom lines never touch stock (no batch, no ledger row), so voids and refunds have nothing to put back.
--   * Typed name and price are the one exception to "the browser never sends prices": validated here (name 2-80
--     characters, price R0.01-R100 000, max 2 decimals), and each sale with custom lines writes an audit row
--     (pos_custom_item_sold) with the names, prices and quantities. Line and order discounts apply as usual; a
--     loyalty reward cannot be used on a custom line.
--   * Two custom lines can be on one sale, so the one-line-per-product rule on pos_sale_items now applies to
--     catalogue lines only (partial unique index), and order discounts are shared out per line instead of per product.
--
-- pos_complete_sale is otherwise unchanged from 20261029006000_rewards_referrals (same signature and grants), and the
-- deferred sale consistency check skips the stock-movement match for custom lines (and refuses one that moved stock).

ALTER TABLE public.pos_sale_items ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false;

-- The hidden placeholder every custom line points at.
CREATE OR REPLACE FUNCTION public.pos_custom_item_product_id()
RETURNS uuid
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$ SELECT '00000000-0000-4000-8000-00000000c057'::uuid $$;
REVOKE EXECUTE ON FUNCTION public.pos_custom_item_product_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_custom_item_product_id() TO service_role;

INSERT INTO public.products (id, slug, name, category, price_rand, unit, is_active, sort_order, description,
                             track_stock, sell_online)
VALUES ('00000000-0000-4000-8000-00000000c057', 'system-custom-till-item', 'Custom item', 'Custom', 0, NULL, false,
        100000, 'System placeholder for custom till items. Do not edit or delete.', false, false)
ON CONFLICT (id) DO NOTHING;

-- The placeholder can't be edited, switched on or deleted from anywhere (editor, sale prices, photos, CSV import,
-- product delete, a direct server call): it must stay inactive and untracked or it could appear in the shop at R0.
CREATE OR REPLACE FUNCTION public._protect_custom_item_placeholder()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.id = '00000000-0000-4000-8000-00000000c057'::uuid THEN
    RAISE EXCEPTION 'custom_item_placeholder_locked: the custom till item placeholder cannot be changed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._protect_custom_item_placeholder() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS products_protect_custom_item_placeholder ON public.products;
CREATE TRIGGER products_protect_custom_item_placeholder
BEFORE UPDATE OR DELETE ON public.products
FOR EACH ROW WHEN (OLD.id = '00000000-0000-4000-8000-00000000c057'::uuid)
EXECUTE FUNCTION public._protect_custom_item_placeholder();

-- One line per catalogue product on a sale, as before; custom lines may repeat the placeholder.
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT c.conname INTO v_name
  FROM pg_constraint c
  WHERE c.conrelid = 'public.pos_sale_items'::regclass AND c.contype = 'u'
    AND c.conkey::int[] @> ARRAY[
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.pos_sale_items'::regclass AND attname = 'sale_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.pos_sale_items'::regclass AND attname = 'product_id')]::int[]
    AND array_length(c.conkey, 1) = 2;
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.pos_sale_items DROP CONSTRAINT %I', v_name);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS pos_sale_items_one_line_per_product
  ON public.pos_sale_items (sale_id, product_id) WHERE NOT is_custom;
-- A custom line is always on the placeholder, and only custom lines are.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_sale_items_custom_chk') THEN
    ALTER TABLE public.pos_sale_items ADD CONSTRAINT pos_sale_items_custom_chk
      CHECK (is_custom = (product_id = '00000000-0000-4000-8000-00000000c057'::uuid));
  END IF;
END $$;

-- The deferred sale check: every catalogue line must have its stock movement; custom lines have none by design.
CREATE OR REPLACE FUNCTION public._check_pos_sale_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items numeric(10,2);
  v_tenders numeric(10,2);
  v_bad integer;
BEGIN
  SELECT COALESCE(SUM(line_total), 0) INTO v_items FROM public.pos_sale_items WHERE sale_id = NEW.id;
  SELECT COALESCE(SUM(amount), 0) INTO v_tenders FROM public.pos_tenders WHERE sale_id = NEW.id;
  IF v_items <> NEW.total THEN
    RAISE EXCEPTION 'sale_total_mismatch: items % <> total %', v_items, NEW.total;
  END IF;
  IF v_tenders <> NEW.total THEN
    RAISE EXCEPTION 'tender_mismatch: tenders % <> total %', v_tenders, NEW.total;
  END IF;
  SELECT COUNT(*) INTO v_bad
  FROM public.pos_sale_items i
  WHERE i.sale_id = NEW.id
    AND NOT i.is_custom
    AND i.quantity <> COALESCE((
      SELECT -SUM(l.quantity_delta) FROM public.inventory_ledger l
      WHERE l.movement_type = 'pos_sale' AND l.reference_type = 'pos_sale_item' AND l.reference_id = i.id
    ), 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'stock_mismatch: % sale line(s) have no matching stock movement', v_bad;
  END IF;
  -- A custom line must never move stock either.
  IF EXISTS (SELECT 1 FROM public.pos_sale_items i JOIN public.inventory_ledger l
               ON l.reference_type = 'pos_sale_item' AND l.reference_id = i.id
             WHERE i.sale_id = NEW.id AND i.is_custom) THEN
    RAISE EXCEPTION 'stock_mismatch: a custom line moved stock';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._check_pos_sale_consistency() FROM PUBLIC, anon, authenticated;

-- Till sale: as 20261029006000_rewards_referrals, plus custom lines (see the header of this file).
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
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,3}$'
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
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity,
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
    v_gross_line_c := v_unit_c * v_line.quantity;
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
    FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, name text, unit_price numeric, quantity integer, item_id uuid,
                                           line_discount_c bigint, is_custom boolean)
    ORDER BY x.product_id, x.item_id
  LOOP
    INSERT INTO public.pos_sale_items (id, sale_id, product_id, product_name, unit_price_rand, quantity,
                                       line_discount_rand, order_discount_rand, line_total, is_custom)
    VALUES (v_line.item_id, v_sale_id, v_line.product_id, v_line.name, v_line.unit_price, v_line.quantity,
            v_line.line_discount_c::numeric / 100, v_line.order_discount_c::numeric / 100,
            v_line.unit_price * v_line.quantity - (v_line.line_discount_c + v_line.order_discount_c)::numeric / 100,
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
$$;
REVOKE ALL ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text, jsonb, text) TO service_role;
