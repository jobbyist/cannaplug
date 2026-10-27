-- Rollback for 20261027001000_sale_expiry: stop ending sales automatically (sale_ends_at is stored only).
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-end-sales';
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.products_end_expired_sales(uuid);
DROP INDEX IF EXISTS public.products_sale_ends_idx;
