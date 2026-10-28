-- 29 Oct 2026: shop subcategories.
--   products.subcategory already exists but was empty for every imported product. The catalogue import wrote the grade
--   into the name ("Purple Fritter (Greenhouse)"), so Flower and Pre-rolls get their subcategory from that bracket:
--   Outdoor, Greenhouse, Greendoor, Premium Indoor (the products named "Entry Indoor"), Top Shelf and Greendoor 2-in-1.
--   Product names are not changed. Products with no grade in their name (Moonstick, Indoor Cannagar) stay empty.
--   Existing values are tidied first (extra spaces, "Top shelf" -> "Top Shelf"), and a check keeps the column tidy:
--   no leading or trailing space, 1 to 60 characters. An index serves the shop's category and subcategory filter.

-- 1. Tidy what is there.
UPDATE public.products
   SET subcategory = NULLIF(btrim(regexp_replace(subcategory, '\s+', ' ', 'g')), '')
 WHERE subcategory IS NOT NULL
   AND subcategory IS DISTINCT FROM NULLIF(btrim(regexp_replace(subcategory, '\s+', ' ', 'g')), '');

UPDATE public.products
   SET subcategory = CASE lower(subcategory)
         WHEN 'outdoor' THEN 'Outdoor'
         WHEN 'greenhouse' THEN 'Greenhouse'
         WHEN 'greendoor' THEN 'Greendoor'
         WHEN 'premium indoor' THEN 'Premium Indoor'
         WHEN 'entry indoor' THEN 'Premium Indoor'
         WHEN 'top shelf' THEN 'Top Shelf'
         WHEN 'greendoor 2-in-1' THEN 'Greendoor 2-in-1' END
 WHERE category IN ('Flower', 'Pre-rolls')
   AND lower(subcategory) IN ('outdoor', 'greenhouse', 'greendoor', 'premium indoor', 'entry indoor', 'top shelf', 'greendoor 2-in-1')
   AND subcategory IS DISTINCT FROM CASE lower(subcategory)
         WHEN 'outdoor' THEN 'Outdoor'
         WHEN 'greenhouse' THEN 'Greenhouse'
         WHEN 'greendoor' THEN 'Greendoor'
         WHEN 'premium indoor' THEN 'Premium Indoor'
         WHEN 'entry indoor' THEN 'Premium Indoor'
         WHEN 'top shelf' THEN 'Top Shelf'
         WHEN 'greendoor 2-in-1' THEN 'Greendoor 2-in-1' END;

-- 2. Fill the grade from the bracket at the end of the name, only where no subcategory is set.
UPDATE public.products p
   SET subcategory = g.grade
  FROM (
    SELECT id,
           CASE lower(btrim(substring(name FROM '\(([^()]*)\)\s*$')))
             WHEN 'outdoor' THEN 'Outdoor'
             WHEN 'greenhouse' THEN 'Greenhouse'
             WHEN 'greendoor' THEN 'Greendoor'
             WHEN 'entry indoor' THEN 'Premium Indoor'
             WHEN 'premium indoor' THEN 'Premium Indoor'
             WHEN 'top shelf' THEN 'Top Shelf'
             WHEN 'greendoor 2-in-1' THEN 'Greendoor 2-in-1' END AS grade
      FROM public.products
     WHERE category IN ('Flower', 'Pre-rolls') AND subcategory IS NULL
  ) g
 WHERE p.id = g.id AND g.grade IS NOT NULL;

-- 3. Keep it tidy, and fast to filter on.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_subcategory_chk') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_subcategory_chk
      CHECK (subcategory IS NULL OR (subcategory = btrim(subcategory) AND length(subcategory) BETWEEN 1 AND 60));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS products_shop_idx ON public.products (category, subcategory)
  WHERE is_active AND sell_online;
