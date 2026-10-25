-- Rolls back 20261025003000_scheduler_fallback: stops the database schedules and removes the caller. The pg_cron and
-- pg_net extensions and the Vault secrets are left in place (remove the secrets in the dashboard if wanted).
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job
      WHERE jobname IN ('cannaplug-dispatch', 'cannaplug-maintenance', 'cannaplug-newsroom-daily');
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.scheduler_call_app(text);
