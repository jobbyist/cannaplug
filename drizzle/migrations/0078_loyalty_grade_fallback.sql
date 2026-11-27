-- 27 Nov 2026: Purple Champagne showed at the till but not in the Loyalty tab (staff report).
--   Cause: the product was added by hand with the category spelled "Prerolls" (the shop's category is "Pre-rolls") and no
--   grade in its name. A loyalty reward covers a product only when its category is one of the reward's categories AND the
--   grade in brackets at the end of its name matches ("Blue Gelato (Greenhouse)"). Purple Champagne failed both, so Loyalty
--   (and the database check at the till) skipped it. The till lists every active product, so it still appeared there.
--
--   Fix, in three parts:
--   1. Category spelling is tidied: "Prerolls", "Pre rolls" and "Pre-Rolls" become "Pre-rolls" (the Plug Back free
--      pre-roll also needs the exact category). The admin product form now saves the shop's spelling too.
--   2. _reward_eligible now ignores punctuation, spaces and case when comparing categories, and reads the grade from the
--      product's Subcategory when one is set, falling back to the bracket in the name as before. Staff can therefore
--      grade a product in /admin -> Products without renaming it. The browser code (src/lib/rewards-logic.ts) mirrors this.
--   3. Purple Champagne (R100, same price as every Entry Indoor pre-roll) is set to the Entry Indoor subcategory so it
--      is covered by the 10-point Indoor reward. Its name is not changed. Change it in /admin -> Products if the owner
--      wants it graded differently.
--
--   No change to who can redeem, what a reward costs, or how stock and points are checked. Same grants as before.

-- 1. Category spelling.
UPDATE public.products
   SET category = 'Pre-rolls'
 WHERE category <> 'Pre-rolls'
   AND regexp_replace(lower(category), '[^a-z0-9]', '', 'g') = 'prerolls';

-- 2. The rule.
CREATE OR REPLACE FUNCTION public._reward_eligible(p_reward text, p_product uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.loyalty_rewards r JOIN public.products p ON p.id = p_product
  WHERE r.code = p_reward AND r.is_active AND p.is_active
    AND regexp_replace(lower(p.category), '[^a-z0-9]', '', 'g') IN (
      SELECT regexp_replace(lower(c), '[^a-z0-9]', '', 'g') FROM unnest(r.categories) AS c)
    AND lower(btrim(COALESCE(NULLIF(btrim(p.subcategory), ''), substring(p.name from '\(([^)]*)\)\s*$')))) = lower(btrim(r.grade))) $$;

REVOKE ALL ON FUNCTION public._reward_eligible(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reward_eligible(text, uuid) TO service_role;

-- 3. Purple Champagne (only if it is still ungraded and still R100).
UPDATE public.products
   SET subcategory = 'Entry Indoor'
 WHERE id = '55a14ee6-d450-48e4-8843-e5bb050e5303'
   AND name = 'Purple Champagne'
   AND subcategory IS NULL
   AND price_rand = 100;
