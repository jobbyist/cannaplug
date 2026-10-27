-- Rollback for 20261027003000_sales_reports: no sales report functions, daily email or POS realtime.
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cannaplug-daily-sales';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables
             WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'pos_sales') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.pos_sales;
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.sales_report_email(uuid, date, text);
DROP FUNCTION IF EXISTS public.sales_daily_report_enqueue(date);
DROP FUNCTION IF EXISTS public._sales_report_email_data(date);
DROP FUNCTION IF EXISTS public.sales_report(uuid, date, date);
DROP FUNCTION IF EXISTS public._sales_report(date, date);
DROP INDEX IF EXISTS public.pos_sales_created_idx;
DROP INDEX IF EXISTS public.pos_refunds_created_idx;
DROP INDEX IF EXISTS public.orders_created_idx;
