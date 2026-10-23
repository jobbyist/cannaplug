-- Prompt 4 (23 Oct 2026): managers pick the homepage's featured products; the homepage falls back to in-stock
-- products when none are picked. Readable by the public like the rest of the catalogue columns.
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;
GRANT SELECT (is_featured) ON public.products TO anon, authenticated;
CREATE INDEX IF NOT EXISTS products_featured_idx ON public.products (sort_order) WHERE is_featured AND is_active;
