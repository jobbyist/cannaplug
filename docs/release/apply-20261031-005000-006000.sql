-- Cannaplug: apply 20261031005000_outdoor_batches and 20261031006000_plug_back to the hosted project.
-- Runs as one transaction: everything applies, or nothing does. Paste all of it into the Supabase SQL Editor and click Run.
BEGIN;

-- ===== 20261031005000_outdoor_batches =====
-- 31 Oct 2026: Outdoor flower is sold in batches of 5 g.
--   Outdoor products are priced per gram (R24/g, so R120 for a 5 g bag) and counted in grams. From now on a customer or a
--   cashier can only buy them in multiples of 5 g (5, 10, 15 ...), online and at the till.
--   * products.weight_step_g may now be 0.5, 1 or 5. A trigger keeps every weighed Outdoor flower product at 5, whoever
--     creates or edits it (admin form, CSV import, catalogue import), and the existing Outdoor products are moved to 5 now.
--   * order_items and pos_sale_items refuse a quantity that is not a multiple of the product's step
--     ('invalid_batch_size'), so the rule holds on every path that writes a line (checkout, till, anything added later).
--     Lines already stored are not touched. Refunds do not write new lines, so refunding part of a bag still works.
--   * bulk_upsert_products (product CSV import) accepts weight_step_g 5, so an exported file imports again unchanged.
--     The function body is otherwise identical to 20261025001000_product_csv.
--   Products that are not weighed (a bag sold as one unit) are never affected. This file contains DROP CONSTRAINT.

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_weight_step_chk;
ALTER TABLE public.products ADD CONSTRAINT products_weight_step_chk CHECK (weight_step_g IN (0.5, 1, 5));

-- Is this a weighed Outdoor flower product? (category Flower and the grade "Outdoor", as the subcategory or in the name)
CREATE OR REPLACE FUNCTION public._is_outdoor_flower(p_category text, p_subcategory text, p_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT p_category = 'Flower'
  AND (lower(COALESCE(p_subcategory, '')) = 'outdoor' OR COALESCE(p_name, '') ~* '\(outdoor\)\s*$') $$;

CREATE OR REPLACE FUNCTION public._products_outdoor_step()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.sold_by_weight AND public._is_outdoor_flower(NEW.category, NEW.subcategory, NEW.name) THEN
    NEW.weight_step_g := 5;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS products_outdoor_step ON public.products;
CREATE TRIGGER products_outdoor_step
  -- Not "UPDATE OF <columns>": a column list would make older rollbacks (which drop sold_by_weight) refuse to run.
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public._products_outdoor_step();

-- The Outdoor products that exist now.
UPDATE public.products SET weight_step_g = 5
WHERE sold_by_weight AND public._is_outdoor_flower(category, subcategory, name) AND weight_step_g <> 5;

-- The smallest purchase and the step of a product: 5 for weighed Outdoor flower, otherwise 1 (whole grams or whole units).
CREATE OR REPLACE FUNCTION public._sale_step(p_product uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT COALESCE((SELECT CASE WHEN p.sold_by_weight AND p.weight_step_g >= 1 THEN p.weight_step_g::integer ELSE 1 END
                       FROM public.products p WHERE p.id = p_product), 1) $$;

CREATE OR REPLACE FUNCTION public._enforce_sale_step()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_step integer;
  v_name text;
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;
  v_step := public._sale_step(NEW.product_id);
  IF v_step > 1 AND NEW.quantity % v_step <> 0 THEN
    SELECT p.name INTO v_name FROM public.products p WHERE p.id = NEW.product_id;
    RAISE EXCEPTION 'invalid_batch_size: % is sold in batches of % g (asked for %)', v_name, v_step, NEW.quantity;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS order_items_sale_step ON public.order_items;
CREATE TRIGGER order_items_sale_step BEFORE INSERT OR UPDATE OF quantity, product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_sale_step();
DROP TRIGGER IF EXISTS pos_sale_items_sale_step ON public.pos_sale_items;
CREATE TRIGGER pos_sale_items_sale_step BEFORE INSERT OR UPDATE OF quantity, product_id ON public.pos_sale_items
  FOR EACH ROW EXECUTE FUNCTION public._enforce_sale_step();

-- Product CSV import: weight_step_g may be 5 (identical to 20261025001000 apart from that one value).
CREATE OR REPLACE FUNCTION public.bulk_upsert_products(
  p_actor uuid,
  p_rows jsonb,
  p_file_sha256 text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_categories constant text[] := ARRAY['Flower','Pre-rolls','Edibles','Drinks','CBD','Vapes','Concentrates',
                                         'Accessories','Lounge'];
  c_keys constant text[] := ARRAY['sku','slug','name','category','price','sale_price','sale_ends','cost','brand',
                                   'barcode','unit','description','sold_by_weight','weight_step_g','sell_online',
                                   'is_featured','is_active','opening_qty'];
  c_money constant text := '^[0-9]{1,7}(\.[0-9]{1,2})?$';
  v_cached jsonb;
  e jsonb;
  v_sku text;
  v_ex public.products;
  v_found boolean;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_cur_regular numeric;
  v_cur_sale numeric;
  v_regular numeric;
  v_sale numeric;
  v_ends timestamptz;
  v_category text;
  v_lounge boolean;
  v_slug text;
  v_id uuid;
  v_batch uuid;
  v_qty int;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_stocked int := 0;
  v_units bigint := 0;
  v_sale_ended int := 0;
  v_skus text[];
  v_summary jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  IF p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_file_hash'; END IF;
  v_cached := public._idem_begin('bulk_upsert_products', p_actor, p_idempotency_key,
    jsonb_build_object('h', p_file_sha256, 'r', p_rows));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid_rows: 1 to 2000 rows';
  END IF;
  -- Shape of every row before anything is written.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) x
    WHERE jsonb_typeof(x) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(x) k WHERE k <> ALL (c_keys))
       OR length(btrim(COALESCE(x->>'sku', ''))) NOT BETWEEN 1 AND 64
       OR (x ? 'name' AND length(btrim(COALESCE(x->>'name', ''))) NOT BETWEEN 1 AND 160)
       OR (x ? 'category' AND COALESCE(x->>'category', '') <> ALL (c_categories))
       OR (x ? 'price' AND (COALESCE(x->>'price', '') !~ c_money OR (x->>'price')::numeric <= 0))
       OR (x ? 'sale_price' AND x->'sale_price' <> 'null'::jsonb AND COALESCE(x->>'sale_price', '') !~ c_money)
       OR (x ? 'cost' AND x->'cost' <> 'null'::jsonb AND COALESCE(x->>'cost', '') !~ c_money)
       OR (x ? 'sale_ends' AND x->'sale_ends' <> 'null'::jsonb AND jsonb_typeof(x->'sale_ends') <> 'string')
       OR (x ? 'brand' AND x->'brand' <> 'null'::jsonb AND length(x->>'brand') NOT BETWEEN 1 AND 80)
       OR (x ? 'barcode' AND x->'barcode' <> 'null'::jsonb AND COALESCE(x->>'barcode', '') !~ '^[0-9A-Za-z-]{4,48}$')
       OR (x ? 'unit' AND x->'unit' <> 'null'::jsonb AND length(x->>'unit') NOT BETWEEN 1 AND 24)
       OR (x ? 'description' AND x->'description' <> 'null'::jsonb AND length(x->>'description') NOT BETWEEN 1 AND 4000)
       OR (x ? 'sold_by_weight' AND jsonb_typeof(x->'sold_by_weight') <> 'boolean')
       OR (x ? 'sell_online' AND jsonb_typeof(x->'sell_online') <> 'boolean')
       OR (x ? 'is_featured' AND jsonb_typeof(x->'is_featured') <> 'boolean')
       OR (x ? 'is_active' AND jsonb_typeof(x->'is_active') <> 'boolean')
       OR (x ? 'weight_step_g' AND COALESCE(x->>'weight_step_g', '') NOT IN ('0.5', '1', '1.0', '5', '5.0'))
       OR (x ? 'opening_qty' AND COALESCE(x->>'opening_qty', '') !~ '^[0-9]{1,6}$')
       OR (x ? 'slug' AND COALESCE(x->>'slug', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$')
  ) THEN
    RAISE EXCEPTION 'invalid_rows: a row has an unknown field or a value in the wrong format';
  END IF;
  SELECT array_agg(lower(btrim(x->>'sku'))) INTO v_skus FROM jsonb_array_elements(p_rows) x;
  IF (SELECT count(DISTINCT s) FROM unnest(v_skus) s) <> array_length(v_skus, 1) THEN
    RAISE EXCEPTION 'duplicate_sku_in_file';
  END IF;

  -- Rows in SKU order so two uploads lock products in the same order.
  FOR e IN SELECT x FROM jsonb_array_elements(p_rows) x ORDER BY lower(btrim(x->>'sku')) LOOP
    v_sku := btrim(e->>'sku');
    SELECT * INTO v_ex FROM public.products WHERE lower(sku) = lower(v_sku) FOR UPDATE;
    v_found := FOUND;
    IF v_found THEN v_sku := v_ex.sku; END IF; -- messages and audit use the stored spelling

    IF e ? 'barcode' AND e->'barcode' <> 'null'::jsonb AND EXISTS (
      SELECT 1 FROM public.products WHERE lower(barcode) = lower(e->>'barcode')
        AND (NOT v_found OR id <> v_ex.id)
    ) THEN
      RAISE EXCEPTION 'barcode_in_use: %', v_sku;
    END IF;

    -- Pricing: the same rule as the product editor and the planner in src/lib/product-csv.ts.
    IF v_found THEN
      v_cur_regular := COALESCE(v_ex.regular_price_rand, v_ex.price_rand);
      v_cur_sale := CASE WHEN v_ex.regular_price_rand IS NOT NULL THEN v_ex.price_rand END;
    ELSE
      v_cur_regular := NULL;
      v_cur_sale := NULL;
    END IF;
    v_regular := COALESCE((e->>'price')::numeric, v_cur_regular);
    IF v_regular IS NULL THEN RAISE EXCEPTION 'new_product_incomplete: % needs name, category and price', v_sku; END IF;
    IF e ? 'sale_price' THEN
      v_sale := (e->>'sale_price')::numeric;
      IF v_sale IS NOT NULL AND v_sale >= v_regular THEN
        RAISE EXCEPTION 'sale_price_not_lower: %', v_sku;
      END IF;
    ELSE
      v_sale := v_cur_sale;
      IF v_sale IS NOT NULL AND v_sale >= v_regular THEN
        v_sale := NULL;
        v_sale_ended := v_sale_ended + 1;
      END IF;
    END IF;
    IF v_sale IS NULL THEN
      IF e ? 'sale_ends' AND e->'sale_ends' <> 'null'::jsonb THEN
        RAISE EXCEPTION 'sale_ends_without_sale: %', v_sku;
      END IF;
      v_ends := NULL;
    ELSIF e ? 'sale_ends' THEN
      v_ends := (e->>'sale_ends')::timestamptz;
    ELSE
      v_ends := CASE WHEN v_found THEN v_ex.sale_ends_at END;
    END IF;

    v_category := COALESCE(e->>'category', CASE WHEN v_found THEN v_ex.category END);
    v_lounge := v_category = 'Lounge';
    IF v_lounge AND COALESCE((e->>'sell_online')::boolean, false) THEN
      RAISE EXCEPTION 'lounge_in_store_only: %', v_sku;
    END IF;

    IF v_found THEN
      IF (v_ex.category = 'Lounge') <> v_lounge THEN RAISE EXCEPTION 'lounge_category_change: %', v_sku; END IF;
      v_before := to_jsonb(v_ex);
      UPDATE public.products SET
        name = CASE WHEN e ? 'name' THEN btrim(e->>'name') ELSE name END,
        category = v_category,
        price_rand = COALESCE(v_sale, v_regular),
        regular_price_rand = CASE WHEN v_sale IS NOT NULL THEN v_regular END,
        sale_ends_at = v_ends,
        cost_rand = CASE WHEN e ? 'cost' THEN (e->>'cost')::numeric ELSE cost_rand END,
        brand = CASE WHEN e ? 'brand' THEN btrim(e->>'brand') ELSE brand END,
        barcode = CASE WHEN e ? 'barcode' THEN e->>'barcode' ELSE barcode END,
        unit = CASE WHEN e ? 'unit' THEN btrim(e->>'unit') ELSE unit END,
        description = CASE WHEN e ? 'description' THEN e->>'description' ELSE description END,
        sold_by_weight = COALESCE((e->>'sold_by_weight')::boolean, sold_by_weight),
        weight_step_g = COALESCE((e->>'weight_step_g')::numeric, weight_step_g),
        sell_online = CASE WHEN v_lounge THEN false ELSE COALESCE((e->>'sell_online')::boolean, sell_online) END,
        is_featured = COALESCE((e->>'is_featured')::boolean, is_featured),
        is_active = COALESCE((e->>'is_active')::boolean, is_active)
      WHERE id = v_ex.id
      RETURNING to_jsonb(products.*) INTO v_after;
      v_id := v_ex.id;
      SELECT COALESCE(array_agg(k ORDER BY k), '{}') INTO v_changed
      FROM jsonb_object_keys(v_after) k WHERE v_after->k IS DISTINCT FROM v_before->k;
    ELSE
      IF NOT (e ? 'name' AND e ? 'category' AND e ? 'price') THEN
        RAISE EXCEPTION 'new_product_incomplete: % needs name, category and price', v_sku;
      END IF;
      v_slug := COALESCE(NULLIF(e->>'slug', ''), 'product-' || substr(md5(lower(v_sku)), 1, 8));
      IF EXISTS (SELECT 1 FROM public.products WHERE slug = v_slug) THEN
        v_slug := v_slug || '-' || substr(md5(lower(v_sku)), 1, 6);
      END IF;
      INSERT INTO public.products (slug, name, category, price_rand, regular_price_rand, sale_ends_at, cost_rand,
                                   brand, barcode, unit, description, sku, sold_by_weight, weight_step_g,
                                   track_stock, sell_online, is_featured, is_active, sort_order)
      VALUES (v_slug, btrim(e->>'name'), v_category, COALESCE(v_sale, v_regular),
              CASE WHEN v_sale IS NOT NULL THEN v_regular END, v_ends, (e->>'cost')::numeric,
              NULLIF(btrim(COALESCE(e->>'brand', '')), ''), e->>'barcode', NULLIF(btrim(COALESCE(e->>'unit', '')), ''),
              e->>'description', v_sku, COALESCE((e->>'sold_by_weight')::boolean, false),
              COALESCE((e->>'weight_step_g')::numeric, 1), NOT v_lounge,
              CASE WHEN v_lounge THEN false ELSE COALESCE((e->>'sell_online')::boolean, true) END,
              COALESCE((e->>'is_featured')::boolean, false), COALESCE((e->>'is_active')::boolean, true), 100)
      RETURNING id INTO v_id;
      v_changed := ARRAY['created'];
    END IF;

    -- Opening stock only for products that have never had stock.
    v_qty := COALESCE((e->>'opening_qty')::int, 0);
    IF NOT EXISTS (SELECT 1 FROM public.inventory_batches WHERE product_id = v_id) THEN
      IF v_lounge THEN
        -- Same as the Yoco import: services get one SERVICE batch so the till can sell them.
        INSERT INTO public.inventory_batches (product_id, batch_code, notes, created_by)
        VALUES (v_id, 'SERVICE', 'Service item: capacity, not physical stock', p_actor)
        RETURNING id INTO v_batch;
        PERFORM public._lock_batches(ARRAY[v_batch]);
        INSERT INTO public.inventory_ledger (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
        VALUES (v_batch, v_id, 100000, 'Service capacity (not physical stock)', p_actor, 'receipt');
      ELSIF v_qty > 0 THEN
        INSERT INTO public.inventory_batches (product_id, batch_code, unit_cost_rand, notes, created_by)
        VALUES (v_id, 'OPENING-CSV', (SELECT cost_rand FROM public.products WHERE id = v_id),
                'Opening stock from a product CSV upload', p_actor)
        RETURNING id INTO v_batch;
        PERFORM public._lock_batches(ARRAY[v_batch]);
        INSERT INTO public.inventory_ledger (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
        VALUES (v_batch, v_id, v_qty, 'Opening stock (product CSV)', p_actor, 'receipt');
        v_stocked := v_stocked + 1;
        v_units := v_units + v_qty;
        v_changed := array_append(v_changed, 'opening_stock');
      END IF;
    END IF;

    IF v_changed = ARRAY['created'] OR 'created' = ANY (v_changed) THEN
      v_created := v_created + 1;
      PERFORM public._audit(p_actor, 'product_created', 'product', v_id,
        jsonb_build_object('source', 'csv', 'sku', v_sku, 'price_rand', COALESCE(v_sale, v_regular)));
    ELSIF cardinality(v_changed) > 0 THEN
      v_updated := v_updated + 1;
      -- Field names only (cost is manager information); the price is logged like the editor does.
      PERFORM public._audit(p_actor, 'product_updated', 'product', v_id,
        jsonb_build_object('source', 'csv', 'sku', v_sku, 'changed', to_jsonb(v_changed),
                           'price_rand', COALESCE(v_sale, v_regular)));
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;
  END LOOP;

  v_summary := jsonb_build_object('rows', jsonb_array_length(p_rows), 'created', v_created, 'updated', v_updated,
    'unchanged', v_unchanged, 'stocked_products', v_stocked, 'opening_units', v_units, 'sales_ended', v_sale_ended);
  PERFORM public._audit(p_actor, 'products_csv_imported', 'catalogue_import', NULL,
    v_summary || jsonb_build_object('file_sha256', p_file_sha256));
  RETURN public._idem_finish('bulk_upsert_products', p_actor, p_idempotency_key, v_summary);
END;
$$;
REVOKE ALL ON FUNCTION public.bulk_upsert_products(uuid, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_upsert_products(uuid, jsonb, text, text) TO service_role;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['_is_outdoor_flower', '_products_outdoor_step', '_sale_step', '_enforce_sale_step'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

-- ===== 20261031006000_plug_back =====
-- 31 Oct 2026: the Plug Back program. A member who brings back 10 empty pre-roll tubes earns 1 complimentary
-- Greenhouse pre-roll. Staff record the tubes at the till and give the free pre-roll in the admin dashboard (Loyalty tab).
--   plug_back_ledger: append-only count of tubes. +n when staff record returned tubes, -10 when a free pre-roll is
--     given, +10 again if that sale is voided. Its balance is the sum of the rows; there is no second counter to drift.
--   plug_back_redeem: gives the free pre-roll as a normal R0 till sale (pos_complete_sale with a 100% line discount) and
--     takes the tubes off in the same transaction, so the receipt, the stock movement and the tube count always agree.
--   Voiding that sale gives the tubes back (trigger on pos_sales). Nothing here touches loyalty points.
-- Every function is SECURITY DEFINER, search_path = '', has an explicit actor, an idempotency key and an audit row, and can
-- be executed by service_role only. The table has RLS and no browser grants. No DROP and no DELETE in this file.

CREATE TABLE IF NOT EXISTS public.plug_back_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  tubes integer NOT NULL CHECK (tubes <> 0),
  source_type text NOT NULL CHECK (source_type IN ('return', 'redeem', 'redeem_void')),
  source_id uuid NOT NULL,
  sale_id uuid REFERENCES public.pos_sales (id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR length(note) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_type = 'return' AND tubes > 0) OR (source_type = 'redeem' AND tubes < 0) OR (source_type = 'redeem_void' AND tubes > 0)),
  CHECK (source_type = 'return' OR sale_id IS NOT NULL),
  UNIQUE (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS plug_back_ledger_user_idx ON public.plug_back_ledger (user_id, created_at DESC);
ALTER TABLE public.plug_back_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plug_back_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.plug_back_ledger TO service_role;
COMMENT ON TABLE public.plug_back_ledger IS 'Plug Back: empty pre-roll tubes returned (+) and spent on a free Greenhouse pre-roll (-). Append-only.';

CREATE OR REPLACE FUNCTION public._plug_back_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN RAISE EXCEPTION 'plug_back_ledger is append-only'; END; $$;
DROP TRIGGER IF EXISTS plug_back_ledger_append_only ON public.plug_back_ledger;
CREATE TRIGGER plug_back_ledger_append_only BEFORE UPDATE OR DELETE ON public.plug_back_ledger
  FOR EACH ROW EXECUTE FUNCTION public._plug_back_append_only();

-- The rule, in one place: tubes needed for one free pre-roll.
CREATE OR REPLACE FUNCTION public.plug_back_tubes_per_reward()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 10 $$;

-- The free pre-roll must be a Greenhouse pre-roll that is on sale (same grade rule as the points rewards).
CREATE OR REPLACE FUNCTION public._plug_back_eligible(p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.products p
  WHERE p.id = p_product AND p.is_active AND p.category = 'Pre-rolls'
    AND lower(substring(p.name from '\(([^)]*)\)\s*$')) = 'greenhouse') $$;

CREATE OR REPLACE FUNCTION public._plug_back_balance(p_user uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT COALESCE(SUM(tubes), 0)::integer FROM public.plug_back_ledger WHERE user_id = p_user $$;

-- One lock per member, so two tills cannot spend the same tubes.
CREATE OR REPLACE FUNCTION public._plug_back_lock(p_user uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$ SELECT pg_advisory_xact_lock(hashtextextended('plugback:' || p_user::text, 0)) $$;

-- What a member has, and what the till can give them (read-only).
CREATE OR REPLACE FUNCTION public.plug_back_summary(p_actor uuid, p_customer uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_bal integer;
  v_per integer := public.plug_back_tubes_per_reward();
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  v_bal := public._plug_back_balance(p_customer);
  RETURN jsonb_build_object(
    'tubes', v_bal,
    'tubes_per_reward', v_per,
    'rewards_available', v_bal / v_per,
    'tubes_to_next', CASE WHEN v_bal % v_per = 0 AND v_bal > 0 THEN 0 ELSE v_per - (v_bal % v_per) END,
    'lifetime_tubes', COALESCE((SELECT SUM(tubes) FROM public.plug_back_ledger WHERE user_id = p_customer AND source_type = 'return'), 0),
    'rewards_given', COALESCE((SELECT count(*) FROM public.plug_back_ledger l WHERE l.user_id = p_customer AND l.source_type = 'redeem'
                               AND NOT EXISTS (SELECT 1 FROM public.plug_back_ledger v WHERE v.source_type = 'redeem_void' AND v.source_id = l.source_id)), 0),
    'products', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'price_rand', p.price_rand) ORDER BY p.name)
                          FROM public.products p WHERE public._plug_back_eligible(p.id)), '[]'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', h.source_type, 'tubes', h.tubes, 'at', h.created_at) ORDER BY h.created_at DESC)
                         FROM (SELECT * FROM public.plug_back_ledger WHERE user_id = p_customer ORDER BY created_at DESC LIMIT 10) h), '[]'::jsonb));
END;
$$;

-- Staff record tubes a member has brought back.
CREATE OR REPLACE FUNCTION public.plug_back_record_return(p_actor uuid, p_customer uuid, p_tubes integer, p_note text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_id uuid := gen_random_uuid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('plug_back_return', p_actor, p_idempotency_key,
    jsonb_build_object('c', p_customer, 't', p_tubes, 'n', v_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_tubes IS NULL OR p_tubes NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_quantity: record between 1 and 100 tubes at a time';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 200 THEN RAISE EXCEPTION 'invalid_input: note is too long'; END IF;
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  PERFORM public._plug_back_lock(p_customer);
  INSERT INTO public.plug_back_ledger (id, user_id, tubes, source_type, source_id, actor_id, note)
  VALUES (v_id, p_customer, p_tubes, 'return', v_id, p_actor, v_note);
  PERFORM public._audit(p_actor, 'plug_back_return', 'plug_back', p_customer,
    jsonb_build_object('tubes', p_tubes, 'balance', public._plug_back_balance(p_customer)));
  v_response := jsonb_build_object('customer_id', p_customer, 'recorded', p_tubes, 'tubes', public._plug_back_balance(p_customer));
  RETURN public._idem_finish('plug_back_return', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Give the free Greenhouse pre-roll: an R0 till sale and the tube deduction, in one transaction.
CREATE OR REPLACE FUNCTION public.plug_back_redeem(p_actor uuid, p_session_id uuid, p_customer uuid, p_product uuid, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_per integer := public.plug_back_tubes_per_reward();
  v_sale jsonb;
  v_sale_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('plug_back_redeem', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_session_id, 'c', p_customer, 'p', p_product));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_customer IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  IF p_product IS NULL OR NOT public._plug_back_eligible(p_product) THEN
    RAISE EXCEPTION 'reward_not_eligible: Plug Back gives one free Greenhouse pre-roll';
  END IF;
  PERFORM public._plug_back_lock(p_customer);
  IF public._plug_back_balance(p_customer) < v_per THEN
    RAISE EXCEPTION 'insufficient_tubes: % tubes are needed for a free pre-roll, the member has %', v_per, public._plug_back_balance(p_customer);
  END IF;

  -- The free pre-roll is a normal till sale, so the receipt, stock, till session and audit trail all exist.
  v_sale := public.pos_complete_sale(
    p_actor, p_session_id,
    jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', 1,
                                         'discount', jsonb_build_object('kind', 'percent', 'value', '100'))),
    '[]'::jsonb, p_customer, 'plugback-' || p_idempotency_key, NULL, 'Plug Back reward');
  v_sale_id := (v_sale->>'sale_id')::uuid;

  INSERT INTO public.plug_back_ledger (user_id, tubes, source_type, source_id, sale_id, actor_id)
  VALUES (p_customer, -v_per, 'redeem', v_sale_id, v_sale_id, p_actor);
  PERFORM public._audit(p_actor, 'plug_back_redeemed', 'pos_sale', v_sale_id,
    jsonb_build_object('tubes', v_per, 'customer_id', p_customer, 'product_id', p_product,
                       'balance', public._plug_back_balance(p_customer)));
  v_response := v_sale || jsonb_build_object('tubes_spent', v_per, 'tubes', public._plug_back_balance(p_customer));
  RETURN public._idem_finish('plug_back_redeem', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Voiding the free sale gives the tubes back.
CREATE OR REPLACE FUNCTION public._plug_back_void_restore()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_spent integer;
BEGIN
  IF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' THEN
    SELECT COALESCE(-SUM(tubes), 0) INTO v_spent FROM public.plug_back_ledger
    WHERE source_type = 'redeem' AND source_id = NEW.id;
    IF v_spent > 0 THEN
      PERFORM public._plug_back_lock(NEW.customer_id);
      INSERT INTO public.plug_back_ledger (user_id, tubes, source_type, source_id, sale_id, actor_id, note)
      VALUES (NEW.customer_id, v_spent, 'redeem_void', NEW.id, NEW.id, NEW.voided_by, 'Sale voided')
      ON CONFLICT (source_type, source_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS pos_sales_plug_back_void ON public.pos_sales;
CREATE TRIGGER pos_sales_plug_back_void AFTER UPDATE OF status ON public.pos_sales
  FOR EACH ROW EXECUTE FUNCTION public._plug_back_void_restore();

REVOKE ALL ON FUNCTION public._plug_back_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_tubes_per_reward() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_eligible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_lock(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._plug_back_void_restore() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_summary(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_record_return(uuid, uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.plug_back_redeem(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plug_back_tubes_per_reward() TO service_role;
GRANT EXECUTE ON FUNCTION public._plug_back_eligible(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._plug_back_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._plug_back_lock(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.plug_back_summary(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.plug_back_record_return(uuid, uuid, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.plug_back_redeem(uuid, uuid, uuid, uuid, text) TO service_role;

-- ===== record both in the migration history (same naming as the earlier ones) =====
DO $$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
      ('20261031005000', '20261031005000_outdoor_batches'),
      ('20261031006000', '20261031006000_plug_back')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

COMMIT;

-- Check (should show: true, true, 4):
SELECT to_regprocedure('public._sale_step(uuid)') IS NOT NULL AS outdoor_batches_applied,
       to_regclass('public.plug_back_ledger') IS NOT NULL AS plug_back_applied,
       (SELECT count(*) FROM public.products WHERE weight_step_g = 5) AS products_at_5g;
