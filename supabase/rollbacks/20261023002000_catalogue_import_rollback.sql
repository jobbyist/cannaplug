-- Rollback for 20261023002000_catalogue_import. Imported products, batches and ledger rows stay (the ledger is
-- append-only); only the new columns, trigger, table and function are removed.
DROP FUNCTION IF EXISTS public.end_expired_sales();
DROP FUNCTION IF EXISTS public.import_catalogue(uuid, jsonb, text, text, boolean, text);
DROP TABLE IF EXISTS public.catalogue_imports;
DROP TRIGGER IF EXISTS order_items_sold_online ON public.order_items;
DROP FUNCTION IF EXISTS public._order_item_sold_online();
REVOKE SELECT (brand, sell_online, track_stock, sold_by_weight, weight_step_g, regular_price_rand, sale_ends_at)
  ON public.products FROM anon, authenticated;
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_weight_step_chk,
  DROP CONSTRAINT IF EXISTS products_sale_price_chk,
  DROP CONSTRAINT IF EXISTS products_sale_end_chk,
  DROP CONSTRAINT IF EXISTS products_brand_len_chk,
  DROP COLUMN IF EXISTS brand,
  DROP COLUMN IF EXISTS sell_online,
  DROP COLUMN IF EXISTS track_stock,
  DROP COLUMN IF EXISTS sold_by_weight,
  DROP COLUMN IF EXISTS weight_step_g,
  DROP COLUMN IF EXISTS regular_price_rand,
  DROP COLUMN IF EXISTS sale_ends_at;
