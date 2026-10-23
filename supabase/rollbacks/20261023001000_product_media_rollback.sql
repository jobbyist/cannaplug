-- Rollback for 20261023001000_product_media. Restores table-wide SELECT for browser roles and drops the new columns.
-- The product-images bucket is left in place (it may hold files); empty and delete it in the dashboard if needed.
REVOKE SELECT (id, slug, name, category, subcategory, description, price_rand, unit, strain_type, badge, sort_order,
               is_active, created_at, sku, barcode, image_path)
  ON public.products FROM anon, authenticated;
GRANT SELECT ON public.products TO anon, authenticated;
DROP INDEX IF EXISTS public.products_sku_unique_idx;
DROP INDEX IF EXISTS public.products_barcode_unique_idx;
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_sku_format_chk,
  DROP CONSTRAINT IF EXISTS products_barcode_format_chk,
  DROP CONSTRAINT IF EXISTS products_cost_nonnegative_chk,
  DROP CONSTRAINT IF EXISTS products_image_path_chk,
  DROP COLUMN IF EXISTS sku,
  DROP COLUMN IF EXISTS barcode,
  DROP COLUMN IF EXISTS cost_rand,
  DROP COLUMN IF EXISTS image_path;
