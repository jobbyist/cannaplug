-- Rollback for 20261031005000_outdoor_batches: removes the 5 g rule and puts the CSV function and the weight-step check
-- back as they were. Products on a 5 g step are first moved back to 1 g (their price is per gram, so nothing else
-- changes). Orders and sales already stored are not touched.
DROP TRIGGER IF EXISTS order_items_sale_step ON public.order_items;
DROP TRIGGER IF EXISTS pos_sale_items_sale_step ON public.pos_sale_items;
DROP TRIGGER IF EXISTS products_outdoor_step ON public.products;
UPDATE public.products SET weight_step_g = 1 WHERE weight_step_g = 5;
DROP FUNCTION IF EXISTS public._enforce_sale_step();
DROP FUNCTION IF EXISTS public._sale_step(uuid);
DROP FUNCTION IF EXISTS public._products_outdoor_step();
DROP FUNCTION IF EXISTS public._is_outdoor_flower(text, text, text);
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_weight_step_chk;
ALTER TABLE public.products ADD CONSTRAINT products_weight_step_chk CHECK (weight_step_g IN (0.5, 1));

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
       OR (x ? 'weight_step_g' AND COALESCE(x->>'weight_step_g', '') NOT IN ('0.5', '1', '1.0'))
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
