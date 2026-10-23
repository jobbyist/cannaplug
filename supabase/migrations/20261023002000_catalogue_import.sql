-- Prompt 3 (23 Oct 2026): import the catalogue from the Yoco POS export, plus the product options the owner asked for.
-- * brand, sell_online (Lounge services are in-store only), track_stock, sold_by_weight + weight_step_g (1 g or 0.5 g),
--   regular_price_rand + sale_ends_at: a product is "on sale" when regular_price_rand > price_rand. The selling price
--   stays price_rand, so every existing pricing path (checkout, POS, reorder) is unchanged.
-- * order_items refuse products that are not sold online (enforced in the database, not only in the shop UI).
-- * import_catalogue(): one transaction per file, idempotent per file hash, opening stock through the normal ledger.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS sell_online boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS track_stock boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sold_by_weight boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weight_step_g numeric(3,1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS regular_price_rand numeric(10,2),
  ADD COLUMN IF NOT EXISTS sale_ends_at timestamptz;

ALTER TABLE public.products
  ADD CONSTRAINT products_weight_step_chk CHECK (weight_step_g IN (0.5, 1)),
  ADD CONSTRAINT products_sale_price_chk CHECK (regular_price_rand IS NULL OR regular_price_rand > price_rand),
  ADD CONSTRAINT products_sale_end_chk CHECK (sale_ends_at IS NULL OR regular_price_rand IS NOT NULL),
  ADD CONSTRAINT products_brand_len_chk CHECK (brand IS NULL OR length(brand) <= 80);

GRANT SELECT (brand, sell_online, track_stock, sold_by_weight, weight_step_g, regular_price_rand, sale_ends_at)
  ON public.products TO anon, authenticated;

-- In-store-only products can never be ordered online, whatever path inserts the order line.
CREATE OR REPLACE FUNCTION public._order_item_sold_online()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.products WHERE id = NEW.product_id AND NOT sell_online
  ) THEN
    RAISE EXCEPTION 'not_sold_online: % is sold in store only', NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._order_item_sold_online() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER order_items_sold_online BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._order_item_sold_online();

CREATE TABLE IF NOT EXISTS public.catalogue_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_sha256 text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('yoco_pos', 'manual')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.catalogue_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.catalogue_imports FROM anon, authenticated;
GRANT ALL ON public.catalogue_imports TO service_role;

-- p_rows: [{sku, name, slug, category, brand, price, cost, unit, sold_by_weight, opening_qty, track_stock, sell_online}]
CREATE OR REPLACE FUNCTION public.import_catalogue(
  p_actor uuid,
  p_rows jsonb,
  p_file_sha256 text,
  p_source text,
  p_deactivate_missing boolean,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_prev jsonb;
  r record;
  v_id uuid;
  v_slug text;
  v_existing public.products;
  v_created int := 0;
  v_updated int := 0;
  v_stocked int := 0;
  v_units bigint := 0;
  v_deactivated int := 0;
  v_batch uuid;
  v_skus text[];
  v_summary jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  IF p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_file_hash'; END IF;
  IF p_source NOT IN ('yoco_pos', 'manual') THEN RAISE EXCEPTION 'invalid_source'; END IF;
  v_cached := public._idem_begin('import_catalogue', p_actor, p_idempotency_key,
    jsonb_build_object('h', p_file_sha256, 'd', p_deactivate_missing));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  -- The same file twice is one import.
  SELECT summary INTO v_prev FROM public.catalogue_imports WHERE file_sha256 = p_file_sha256;
  IF FOUND THEN
    RETURN public._idem_finish('import_catalogue', p_actor, p_idempotency_key,
      v_prev || jsonb_build_object('already_imported', true));
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'invalid_rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) e
    WHERE length(btrim(COALESCE(e->>'sku', ''))) NOT BETWEEN 1 AND 64
       OR length(btrim(COALESCE(e->>'name', ''))) NOT BETWEEN 1 AND 160
       OR length(btrim(COALESCE(e->>'category', ''))) NOT BETWEEN 1 AND 80
       OR COALESCE(e->>'slug', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       OR (e->>'price') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$'
       OR ((e->>'cost') IS NOT NULL AND (e->>'cost') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$')
       OR COALESCE(e->>'opening_qty', '0') !~ '^[0-9]{1,6}$'
  ) THEN
    RAISE EXCEPTION 'invalid_rows: every row needs sku, name, category, slug, price; cost/opening_qty must be numbers';
  END IF;
  SELECT array_agg(lower(btrim(e->>'sku'))) INTO v_skus FROM jsonb_array_elements(p_rows) e;
  IF (SELECT count(DISTINCT s) FROM unnest(v_skus) s) <> array_length(v_skus, 1) THEN
    RAISE EXCEPTION 'duplicate_sku_in_file';
  END IF;

  FOR r IN SELECT * FROM jsonb_to_recordset(p_rows) AS x(
      sku text, name text, slug text, category text, brand text, price numeric, cost numeric, unit text,
      sold_by_weight boolean, opening_qty int, track_stock boolean, sell_online boolean)
  LOOP
    SELECT * INTO v_existing FROM public.products WHERE lower(sku) = lower(btrim(r.sku)) FOR UPDATE;
    IF FOUND THEN
      UPDATE public.products SET
        name = btrim(r.name), category = btrim(r.category), brand = NULLIF(btrim(COALESCE(r.brand, '')), ''),
        price_rand = r.price, cost_rand = r.cost, unit = NULLIF(btrim(COALESCE(r.unit, '')), ''),
        sold_by_weight = COALESCE(r.sold_by_weight, false), track_stock = COALESCE(r.track_stock, true),
        sell_online = COALESCE(r.sell_online, true), is_active = true,
        regular_price_rand = CASE WHEN regular_price_rand > r.price THEN regular_price_rand ELSE NULL END,
        sale_ends_at = CASE WHEN regular_price_rand > r.price THEN sale_ends_at ELSE NULL END
      WHERE id = v_existing.id;
      v_id := v_existing.id;
      v_updated := v_updated + 1;
    ELSE
      v_slug := r.slug;
      IF EXISTS (SELECT 1 FROM public.products WHERE slug = v_slug) THEN
        v_slug := v_slug || '-' || substr(md5(lower(r.sku)), 1, 6);
      END IF;
      INSERT INTO public.products (slug, name, category, brand, price_rand, cost_rand, unit, sku, sold_by_weight,
                                   track_stock, sell_online, is_active, sort_order)
      VALUES (v_slug, btrim(r.name), btrim(r.category), NULLIF(btrim(COALESCE(r.brand, '')), ''), r.price, r.cost,
              NULLIF(btrim(COALESCE(r.unit, '')), ''), btrim(r.sku), COALESCE(r.sold_by_weight, false),
              COALESCE(r.track_stock, true), COALESCE(r.sell_online, true), true, 100)
      RETURNING id INTO v_id;
      v_created := v_created + 1;
    END IF;

    -- Opening stock only for products that have never had stock, so a re-export cannot double the shelf.
    IF COALESCE(r.opening_qty, 0) > 0 AND COALESCE(r.track_stock, true)
       AND NOT EXISTS (SELECT 1 FROM public.inventory_batches WHERE product_id = v_id) THEN
      INSERT INTO public.inventory_batches (product_id, batch_code, unit_cost_rand, notes, created_by)
      VALUES (v_id, 'OPENING-YOCO', r.cost, 'Opening stock from the Yoco POS export', p_actor)
      RETURNING id INTO v_batch;
      PERFORM public._lock_batches(ARRAY[v_batch]);
      INSERT INTO public.inventory_ledger (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
      VALUES (v_batch, v_id, r.opening_qty, 'Opening stock (Yoco import)', p_actor, 'receipt');
      v_stocked := v_stocked + 1;
      v_units := v_units + r.opening_qty;
    ELSIF NOT COALESCE(r.track_stock, true)
       AND NOT EXISTS (SELECT 1 FROM public.inventory_batches WHERE product_id = v_id) THEN
      -- Services (Lounge sessions) carry no physical stock. The till's stock engine still allocates from a batch, so
      -- they get one large SERVICE batch; reports exclude track_stock = false products from stock figures.
      INSERT INTO public.inventory_batches (product_id, batch_code, notes, created_by)
      VALUES (v_id, 'SERVICE', 'Service item: capacity, not physical stock', p_actor)
      RETURNING id INTO v_batch;
      PERFORM public._lock_batches(ARRAY[v_batch]);
      INSERT INTO public.inventory_ledger (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
      VALUES (v_batch, v_id, 100000, 'Service capacity (not physical stock)', p_actor, 'receipt');
    END IF;
  END LOOP;

  IF p_deactivate_missing THEN
    UPDATE public.products SET is_active = false
    WHERE is_active AND (sku IS NULL OR lower(sku) <> ALL (v_skus));
    GET DIAGNOSTICS v_deactivated = ROW_COUNT;
  END IF;

  v_summary := jsonb_build_object('rows', jsonb_array_length(p_rows), 'created', v_created, 'updated', v_updated,
    'stocked_products', v_stocked, 'opening_units', v_units, 'deactivated', v_deactivated);
  INSERT INTO public.catalogue_imports (file_sha256, source, actor_user_id, summary)
  VALUES (p_file_sha256, p_source, p_actor, v_summary);
  PERFORM public._audit(p_actor, 'catalogue_imported', 'catalogue_import', NULL,
    v_summary || jsonb_build_object('source', p_source, 'file_sha256', p_file_sha256));
  RETURN public._idem_finish('import_catalogue', p_actor, p_idempotency_key, v_summary);
END;
$$;
REVOKE ALL ON FUNCTION public.import_catalogue(uuid, jsonb, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_catalogue(uuid, jsonb, text, text, boolean, text) TO service_role;

-- Ends sales whose end time has passed: the regular price becomes the selling price again. Run by the hourly job.
CREATE OR REPLACE FUNCTION public.end_expired_sales()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH ended AS (
    UPDATE public.products
    SET price_rand = regular_price_rand, regular_price_rand = NULL, sale_ends_at = NULL
    WHERE sale_ends_at IS NOT NULL AND sale_ends_at <= now() AND regular_price_rand IS NOT NULL
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM ended;
  IF v_count > 0 THEN
    PERFORM public._audit(NULL, 'sales_ended', 'product', NULL, jsonb_build_object('count', v_count));
  END IF;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.end_expired_sales() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_expired_sales() TO service_role;
