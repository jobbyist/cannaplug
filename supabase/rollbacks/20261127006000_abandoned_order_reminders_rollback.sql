-- Rollback for 20261127006000_abandoned_order_reminders: stop the reminders and remove the member lock.
-- Reminders already queued or sent are left alone.
DO $rb$
DECLARE
  v_sig constant text := 'public.checkout_place_order(uuid,jsonb,text,text,text,uuid,text,numeric,text,text)';
  v_lock constant text := E'    PERFORM pg_advisory_xact_lock(hashtext(''pay_in_store:'' || p_user_id::text)); -- pis_lock\n';
  v_def text := pg_get_functiondef(v_sig::regprocedure);
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'abandoned-order-reminders';
  END IF;
  IF position(v_lock IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_lock, '');
  END IF;
END
$rb$;
DROP FUNCTION IF EXISTS public.abandoned_order_reminders_enqueue();
