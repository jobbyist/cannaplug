-- Rollback for 20261023004000_featured_products.
DROP INDEX IF EXISTS public.products_featured_idx;
REVOKE SELECT (is_featured) ON public.products FROM anon, authenticated;
ALTER TABLE public.products DROP COLUMN IF EXISTS is_featured;
