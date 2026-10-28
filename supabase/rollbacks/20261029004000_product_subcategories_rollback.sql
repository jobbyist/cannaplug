-- Rollback for 20261029004000_product_subcategories: removes the check and the index, and empties the subcategory of the
-- Flower and Pre-roll products whose subcategory is exactly the grade written in their name (what the migration filled in).
-- A subcategory a person chose that differs from the name is left alone. Tidied spellings are not restored.
DROP INDEX IF EXISTS public.products_shop_idx;
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_subcategory_chk;

UPDATE public.products p
   SET subcategory = NULL
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
     WHERE category IN ('Flower', 'Pre-rolls')
  ) g
 WHERE p.id = g.id AND g.grade IS NOT NULL AND p.subcategory = g.grade;
