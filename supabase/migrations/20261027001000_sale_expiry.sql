-- 27 Oct 2026: a sale really ends when its end date passes.
--   A product is on sale while regular_price_rand > price_rand; price_rand is what checkout and the till charge.
--   sale_ends_at was stored but nothing acted on it, so an ended sale kept charging the sale price online and in
--   store. products_end_expired_sales() puts the regular price back, clears the sale and writes one audit row per
--   product. It runs every minute from pg_cron and the app also calls it just before pricing a till sale or an
--   online order, so neither ever charges an expired sale price.
--   p_actor is the staff member who triggered it, or NULL for the scheduler. No idempotency key is needed: the
--   sweep only touches sales that are still open, so repeating it changes nothing.

CREATE INDEX IF NOT EXISTS products_sale_ends_idx ON public.products (sale_ends_at)
  WHERE sale_ends_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.products_end_expired_sales(p_actor uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  END IF;
  WITH due AS (
    SELECT id, price_rand AS sale_price, regular_price_rand AS regular_price, sale_ends_at
    FROM public.products
    WHERE sale_ends_at IS NOT NULL AND sale_ends_at <= now() AND regular_price_rand IS NOT NULL
    FOR UPDATE SKIP LOCKED
  ), ended AS (
    UPDATE public.products p
    SET price_rand = due.regular_price, regular_price_rand = NULL, sale_ends_at = NULL
    FROM due
    WHERE p.id = due.id
    RETURNING p.id, due.sale_price, due.regular_price, due.sale_ends_at
  ), logged AS (
    INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    SELECT p_actor, 'product_sale_ended', 'product', e.id,
           jsonb_build_object('sale_price', e.sale_price, 'regular_price', e.regular_price,
                              'sale_ended_at', e.sale_ends_at, 'by', CASE WHEN p_actor IS NULL THEN 'scheduler' ELSE 'staff' END)
    FROM ended e
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_count FROM logged;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.products_end_expired_sales(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.products_end_expired_sales(uuid) TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-end-sales';
    PERFORM cron.schedule('cannaplug-end-sales', '* * * * *', $c$SELECT public.products_end_expired_sales(NULL)$c$);
  END IF;
END;
$$;
