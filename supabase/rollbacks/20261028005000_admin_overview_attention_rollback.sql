-- Rollback for 20261028005000_admin_overview_attention. Refused while any order is archived (they would
-- reappear in lists). Automatic alert notices are removed; staff_directory returns to its previous shape.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.orders WHERE archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback_blocked: archived orders exist; unarchive them first';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('team-alerts-refresh');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cron job not removed: %', SQLERRM;
END $$;

DROP TRIGGER IF EXISTS team_alert_guard ON public.team_notifications;
DELETE FROM public.team_notifications WHERE source_key IS NOT NULL;
DROP FUNCTION IF EXISTS public._team_alert_guard();
DROP FUNCTION IF EXISTS public.team_alerts_refresh();
DROP FUNCTION IF EXISTS public._team_alert_sync(text, integer, text, text, text, text);
DROP FUNCTION IF EXISTS public._plural(integer, text, text);
DROP FUNCTION IF EXISTS public.admin_attention_counts(uuid);
DROP FUNCTION IF EXISTS public._attention_counts();
DROP FUNCTION IF EXISTS public.admin_set_order_archived(uuid, uuid, boolean, text, text);
DROP FUNCTION IF EXISTS public.admin_customers_page(uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.admin_overview(uuid);
DROP FUNCTION IF EXISTS public._revenue_window(timestamptz, timestamptz);
DROP INDEX IF EXISTS public.team_notifications_source_key_idx;
ALTER TABLE public.team_notifications DROP COLUMN IF EXISTS source_key, DROP COLUMN IF EXISTS alert_count;
DROP INDEX IF EXISTS public.orders_archived_idx;
ALTER TABLE public.orders DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archived_by, DROP COLUMN IF EXISTS archive_reason;

CREATE OR REPLACE FUNCTION public.staff_directory(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id', s.user_id, 'full_name', p.full_name, 'email', u.email,
             'role', s.role::text, 'since', s.since) ORDER BY public.role_level(s.role) DESC, p.full_name NULLS LAST)
    FROM (
      SELECT DISTINCT ON (ur.user_id) ur.user_id, ur.role, ur.created_at AS since
      FROM public.user_roles ur
      WHERE ur.role IN ('budtender', 'manager', 'admin')
      ORDER BY ur.user_id, public.role_level(ur.role) DESC
    ) s
    JOIN auth.users u ON u.id = s.user_id
    LEFT JOIN public.profiles p ON p.id = s.user_id
  ), '[]'::jsonb);
END;
$fn$;
