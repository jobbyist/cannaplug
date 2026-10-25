-- Release verification (25 Oct 2026): the database runs the app's three scheduled jobs itself.
-- GitHub Actions (the scheduler until now) stopped starting jobs: the GitHub account is locked over billing, so the
-- notification dispatcher, the hourly housekeeping (stock holds, loyalty retries, ID sweep, automations) and the daily
-- Journal never ran. pg_cron + pg_net call the same protected app routes on the same schedule. Both schedulers may run
-- together safely: the routes already take leases / skip work that is not due.
--
-- Configuration lives in Supabase Vault, never in this file:
--   cannaplug_app_url          e.g. https://cannaplug012.co.za
--   cannaplug_scheduler_secret a bearer the app accepts (LOVABLE_CRON_SECRET or LOVABLE_CRON_SECRET_PREVIOUS in Vercel)
-- Without both secrets every call is a no-op. Where pg_cron / pg_net are unavailable (local tests) nothing is scheduled.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.scheduler_call_app(p_job text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_path text;
  v_body jsonb;
  v_url text;
  v_secret text;
  v_request bigint;
BEGIN
  v_path := CASE p_job
    WHEN 'dispatch' THEN '/api/public/notifications/dispatch'
    WHEN 'maintenance' THEN '/api/public/inventory/maintenance'
    WHEN 'newsroom-daily' THEN '/api/public/newsroom/run'
  END;
  IF v_path IS NULL THEN RAISE EXCEPTION 'invalid_input: unknown job'; END IF;
  v_body := CASE p_job WHEN 'newsroom-daily' THEN '{"mode":"daily"}'::jsonb ELSE '{}'::jsonb END;
  IF to_regnamespace('vault') IS NULL OR to_regnamespace('net') IS NULL THEN RETURN NULL; END IF;
  EXECUTE $q$SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cannaplug_app_url'$q$ INTO v_url;
  EXECUTE $q$SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cannaplug_scheduler_secret'$q$
    INTO v_secret;
  IF v_url IS NULL OR v_secret IS NULL OR v_url !~ '^https://[a-z0-9.-]+$' THEN
    RAISE NOTICE 'scheduler not configured: add cannaplug_app_url and cannaplug_scheduler_secret to Vault';
    RETURN NULL;
  END IF;
  EXECUTE $q$SELECT net.http_post(url := $1, body := $2,
                                   headers := jsonb_build_object('authorization', 'Bearer ' || $3,
                                                                 'content-type', 'application/json'),
                                   timeout_milliseconds := 120000)$q$
    INTO v_request USING v_url || v_path, v_body, v_secret;
  RETURN v_request;
END;
$$;
REVOKE ALL ON FUNCTION public.scheduler_call_app(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduler_call_app(text) TO service_role;

-- Same three schedules as .github/workflows/scheduled-jobs.yml (UTC).
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job
      WHERE jobname IN ('cannaplug-dispatch', 'cannaplug-maintenance', 'cannaplug-newsroom-daily');
    PERFORM cron.schedule('cannaplug-dispatch', '*/5 * * * *', $c$SELECT public.scheduler_call_app('dispatch')$c$);
    PERFORM cron.schedule('cannaplug-maintenance', '17 * * * *', $c$SELECT public.scheduler_call_app('maintenance')$c$);
    PERFORM cron.schedule('cannaplug-newsroom-daily', '0 4 * * *',
      $c$SELECT public.scheduler_call_app('newsroom-daily')$c$);
  END IF;
END;
$$;
