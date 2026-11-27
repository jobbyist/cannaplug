-- Rollback for 20261127012000_dab_waivers: removes the waiver table (and every signed waiver in it), its functions and the
-- daily clean-up job, and the "needs a waiver" flag on products. Sales already made are untouched. Export the waivers first
-- if they must be kept: they are the only copy.
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'dab-waiver-retention';
  END IF;
END
$rb$;
DROP FUNCTION IF EXISTS public.dab_waiver_create(uuid, jsonb);
DROP FUNCTION IF EXISTS public.dab_waiver_claim(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.dab_waiver_release(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.dab_waiver_link_sale(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.dab_waiver_get(uuid, uuid);
DROP FUNCTION IF EXISTS public.dab_waiver_list(uuid, integer, timestamptz, text);
DROP FUNCTION IF EXISTS public.dab_waiver_record_incident(uuid, uuid, text, boolean, boolean, text, text);
DROP FUNCTION IF EXISTS public.dab_waiver_purge_expired();
DROP TABLE IF EXISTS public.dab_waivers;
ALTER TABLE public.products DROP COLUMN IF EXISTS requires_waiver;
