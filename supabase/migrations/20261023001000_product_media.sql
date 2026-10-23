-- Prompt 2 (23 Oct 2026): products carry a SKU, barcode, cost price and a photo.
-- * sku / barcode: unique when present (sku case-insensitively), so the Yoco import can upsert by SKU.
-- * cost_rand: staff-only. Browser roles lose table-wide SELECT and get every column EXCEPT cost_rand.
-- * image_path: an object in the public-read bucket product-images, shaped products/<uuid>/<uuid>.<jpg|png|webp>.
--   Uploads only happen through server-minted signed upload URLs (storage.objects keeps no policies for this bucket).

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS barcode text,
  ADD COLUMN IF NOT EXISTS cost_rand numeric(12,2),
  ADD COLUMN IF NOT EXISTS image_path text;

ALTER TABLE public.products
  ADD CONSTRAINT products_sku_format_chk CHECK (sku IS NULL OR (length(btrim(sku)) BETWEEN 1 AND 64 AND sku = btrim(sku))),
  ADD CONSTRAINT products_barcode_format_chk CHECK (barcode IS NULL OR barcode ~ '^[0-9A-Za-z-]{4,48}$'),
  ADD CONSTRAINT products_cost_nonnegative_chk CHECK (cost_rand IS NULL OR cost_rand >= 0),
  ADD CONSTRAINT products_image_path_chk CHECK (
    image_path IS NULL OR image_path ~ '^products/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique_idx ON public.products (lower(sku)) WHERE sku IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique_idx ON public.products (barcode) WHERE barcode IS NOT NULL;

-- Cost privacy: column-level SELECT for browser roles (every column except cost_rand).
REVOKE SELECT ON public.products FROM anon, authenticated;
GRANT SELECT (id, slug, name, category, subcategory, description, price_rand, unit, strain_type, badge, sort_order,
              is_active, created_at, sku, barcode, image_path)
  ON public.products TO anon, authenticated;

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('product-images', 'product-images', true, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
    ON CONFLICT (id) DO UPDATE
      SET public = true, file_size_limit = 2097152, allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];
  END IF;
END
$$;
