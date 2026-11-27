-- Rollback for 20261127001000_loyalty_grade_fallback: restores the original reward rule (exact category, grade only from the
-- bracket in the name) and un-grades Purple Champagne. The tidied category spelling ("Pre-rolls") is left as it is: it is the
-- shop's own spelling and nothing depends on the old typo.
CREATE OR REPLACE FUNCTION public._reward_eligible(p_reward text, p_product uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (
  SELECT 1 FROM public.loyalty_rewards r JOIN public.products p ON p.id = p_product
  WHERE r.code = p_reward AND r.is_active AND p.is_active AND p.category = ANY (r.categories)
    AND lower(substring(p.name from '\(([^)]*)\)\s*$')) = lower(r.grade)) $$;

REVOKE ALL ON FUNCTION public._reward_eligible(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reward_eligible(text, uuid) TO service_role;

UPDATE public.products
   SET subcategory = NULL
 WHERE id = '55a14ee6-d450-48e4-8843-e5bb050e5303'
   AND name = 'Purple Champagne'
   AND subcategory = 'Entry Indoor';
