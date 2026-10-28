-- Rollback for 20261028004000_staff_notifications: removes the notification tables and the staff/notification
-- functions. Role assignments already made stay (they live in user_roles). Refused once a manager or admin has
-- written a notice of their own; the two seeded notices do not count.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.team_notifications WHERE created_by IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback_blocked: staff have written notifications; keep this migration or export them first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.team_notification_mark_read(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.team_notification_save(uuid, uuid, text, text, text, text, text, boolean, timestamptz, text, text, text);
DROP FUNCTION IF EXISTS public.staff_set_role(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.staff_find_member(uuid, text);
DROP FUNCTION IF EXISTS public.staff_directory(uuid);
DROP TABLE IF EXISTS public.team_notification_reads;
DROP TABLE IF EXISTS public.team_notifications;
