-- 28 Oct 2026: staff role management and team notifications.
--   * staff_directory / staff_find_member / staff_set_role: managers and admins assign and edit staff roles.
--     A manager can add, change or remove budtenders. An admin can also add, change or remove managers.
--     Admin roles are never changed here (the owner does that), and nobody can change their own role.
--   * team_notifications: important updates drafted by managers and admins and shown to staff under the bell in
--     the admin panel. Staff can read published notices at or below their role over Supabase Realtime (RLS);
--     every write goes through the service-role-only functions below (actor argument, idempotency key, audit).
--   * team_notification_reads: who has read what (own rows only). Marked through a service-role function.
--   * A notice can carry a scheduled replacement (change_at / change_title / change_body) that takes over by
--     itself at that time, so a "going live" notice can flip to "now live" without anyone being online.

-- Staff roles ----------------------------------------------------------------------------------------------------
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

CREATE OR REPLACE FUNCTION public.staff_find_member(p_actor uuid, p_email text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_email text := lower(btrim(COALESCE(p_email, '')));
  v_row jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN
    RAISE EXCEPTION 'invalid_input: enter a full email address';
  END IF;
  SELECT jsonb_build_object(
           'user_id', u.id, 'full_name', p.full_name, 'email', u.email,
           'role', (SELECT ur.role::text FROM public.user_roles ur
                    WHERE ur.user_id = u.id AND ur.role IN ('budtender', 'manager', 'admin')
                    ORDER BY public.role_level(ur.role) DESC LIMIT 1))
    INTO v_row
  FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id
  WHERE lower(u.email) = v_email;
  RETURN v_row;
END;
$fn$;

-- p_role: 'budtender', 'manager' or 'none' (remove staff access; the person stays a member).
CREATE OR REPLACE FUNCTION public.staff_set_role(p_actor uuid, p_target uuid, p_role text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_actor_role public.app_role;
  v_current text;
  v_cached jsonb;
  v_response jsonb;
BEGIN
  v_actor_role := public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('staff_role', p_actor, p_idempotency_key,
    jsonb_build_object('t', p_target, 'r', p_role));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_role IS NULL OR p_role NOT IN ('budtender', 'manager', 'none') THEN
    RAISE EXCEPTION 'invalid_input: role must be budtender, manager or none';
  END IF;
  IF p_target IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target) THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;
  IF p_target = p_actor THEN
    RAISE EXCEPTION 'forbidden: you cannot change your own role' USING ERRCODE = '42501';
  END IF;

  SELECT ur.role::text INTO v_current
  FROM public.user_roles ur
  WHERE ur.user_id = p_target AND ur.role IN ('budtender', 'manager', 'admin')
  ORDER BY public.role_level(ur.role) DESC LIMIT 1;

  IF v_current = 'admin' THEN
    RAISE EXCEPTION 'forbidden: admin roles are managed by the owner' USING ERRCODE = '42501';
  END IF;
  IF v_actor_role = 'manager'
     AND (v_current = 'manager' OR p_role = 'manager') THEN
    RAISE EXCEPTION 'forbidden: only an admin can assign or change manager roles' USING ERRCODE = '42501';
  END IF;

  IF v_current IS NOT DISTINCT FROM (CASE WHEN p_role = 'none' THEN NULL ELSE p_role END) THEN
    v_response := jsonb_build_object('changed', false, 'role', COALESCE(v_current, 'none'));
    RETURN public._idem_finish('staff_role', p_actor, p_idempotency_key, v_response);
  END IF;

  DELETE FROM public.user_roles WHERE user_id = p_target AND role IN ('budtender', 'manager');
  IF p_role <> 'none' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (p_target, p_role::public.app_role);
  END IF;
  PERFORM public._audit(p_actor, 'staff_role_changed', 'user', p_target,
    jsonb_build_object('from', COALESCE(v_current, 'none'), 'to', p_role));
  v_response := jsonb_build_object('changed', true, 'role', p_role, 'previous', COALESCE(v_current, 'none'));
  RETURN public._idem_finish('staff_role', p_actor, p_idempotency_key, v_response);
END;
$fn$;

-- Team notifications -----------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 120),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 1000),
  kind text NOT NULL DEFAULT 'update' CHECK (kind IN ('update', 'reminder', 'alert')),
  min_role text NOT NULL DEFAULT 'budtender' CHECK (min_role IN ('budtender', 'manager', 'admin')),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
  pinned boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  change_at timestamptz,
  change_title text CHECK (change_title IS NULL OR length(btrim(change_title)) BETWEEN 3 AND 120),
  change_body text CHECK (change_body IS NULL OR length(btrim(change_body)) BETWEEN 1 AND 1000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_notifications_change_chk
    CHECK (change_at IS NULL OR (change_title IS NOT NULL AND change_body IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS team_notifications_feed_idx ON public.team_notifications (status, pinned DESC, published_at DESC);

CREATE TABLE IF NOT EXISTS public.team_notification_reads (
  notification_id uuid NOT NULL REFERENCES public.team_notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

ALTER TABLE public.team_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_notification_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.team_notifications, public.team_notification_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.team_notifications, public.team_notification_reads TO authenticated;
GRANT ALL ON public.team_notifications, public.team_notification_reads TO service_role;

DROP POLICY IF EXISTS "staff read team notifications" ON public.team_notifications;
CREATE POLICY "staff read team notifications" ON public.team_notifications FOR SELECT TO authenticated
USING (
  (status = 'published' AND (SELECT public.has_at_least_role(min_role::public.app_role)))
  OR (min_role <> 'admin' AND (SELECT public.has_at_least_role('manager'::public.app_role)))
  OR (SELECT public.has_at_least_role('admin'::public.app_role))
);

DROP POLICY IF EXISTS "own notification reads" ON public.team_notification_reads;
CREATE POLICY "own notification reads" ON public.team_notification_reads FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));

-- Draft, edit, publish or archive a notice. Managers and admins; a manager cannot write admin-only notices.
CREATE OR REPLACE FUNCTION public.team_notification_save(
  p_actor uuid, p_id uuid, p_title text, p_body text, p_kind text, p_min_role text, p_status text,
  p_pinned boolean, p_change_at timestamptz, p_change_title text, p_change_body text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_role public.app_role;
  v_cached jsonb;
  v_title text := btrim(COALESCE(p_title, ''));
  v_body text := btrim(COALESCE(p_body, ''));
  v_ct text := NULLIF(btrim(COALESCE(p_change_title, '')), '');
  v_cb text := NULLIF(btrim(COALESCE(p_change_body, '')), '');
  v_old public.team_notifications;
  v_id uuid;
  v_response jsonb;
BEGIN
  v_role := public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('team_notification', p_actor, p_idempotency_key,
    jsonb_build_object('id', p_id, 't', v_title, 'b', v_body, 'k', p_kind, 'm', p_min_role, 's', p_status,
                       'p', p_pinned, 'ca', p_change_at, 'ct', v_ct, 'cb', v_cb));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF length(v_title) NOT BETWEEN 3 AND 120 THEN
    RAISE EXCEPTION 'invalid_input: the title must be 3 to 120 characters';
  END IF;
  IF length(v_body) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid_input: the message must be 1 to 1000 characters';
  END IF;
  IF p_kind NOT IN ('update', 'reminder', 'alert') OR p_min_role NOT IN ('budtender', 'manager', 'admin')
     OR p_status NOT IN ('draft', 'published', 'archived') THEN
    RAISE EXCEPTION 'invalid_input: unknown type, audience or status';
  END IF;
  IF p_change_at IS NOT NULL AND (v_ct IS NULL OR v_cb IS NULL) THEN
    RAISE EXCEPTION 'invalid_input: a scheduled change needs its own title and message';
  END IF;
  IF p_change_at IS NULL THEN v_ct := NULL; v_cb := NULL; END IF;
  IF v_role = 'manager' AND p_min_role = 'admin' THEN
    RAISE EXCEPTION 'forbidden: only an admin can write admin-only notices' USING ERRCODE = '42501';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.team_notifications
      (title, body, kind, min_role, status, pinned, published_at, change_at, change_title, change_body,
       created_by, updated_by)
    VALUES (v_title, v_body, p_kind, p_min_role, p_status, COALESCE(p_pinned, false),
            CASE WHEN p_status = 'published' THEN now() END, p_change_at, v_ct, v_cb, p_actor, p_actor)
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_old FROM public.team_notifications WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'notification_not_found'; END IF;
    IF v_role = 'manager' AND v_old.min_role = 'admin' THEN
      RAISE EXCEPTION 'forbidden: only an admin can edit admin-only notices' USING ERRCODE = '42501';
    END IF;
    UPDATE public.team_notifications SET
      title = v_title, body = v_body, kind = p_kind, min_role = p_min_role, status = p_status,
      pinned = COALESCE(p_pinned, false),
      published_at = CASE WHEN p_status = 'published' AND v_old.published_at IS NULL THEN now()
                          ELSE v_old.published_at END,
      change_at = p_change_at, change_title = v_ct, change_body = v_cb,
      updated_by = p_actor, updated_at = now()
    WHERE id = p_id;
    v_id := p_id;
  END IF;
  PERFORM public._audit(p_actor, 'team_notification_saved', 'team_notification', v_id,
    jsonb_build_object('status', p_status, 'audience', p_min_role, 'created', p_id IS NULL));
  v_response := jsonb_build_object('id', v_id, 'status', p_status);
  RETURN public._idem_finish('team_notification', p_actor, p_idempotency_key, v_response);
END;
$fn$;

-- Mark notices as read for the acting staff member (only ones they are allowed to see). Re-marking only moves
-- the read time forward, so a notice that was edited or flipped since is shown as unread again until re-read.
CREATE OR REPLACE FUNCTION public.team_notification_mark_read(p_actor uuid, p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_role public.app_role;
  v_n integer;
BEGIN
  v_role := public._assert_staff(p_actor, 'budtender');
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_ids) > 200 THEN RAISE EXCEPTION 'invalid_input: too many notices at once'; END IF;
  INSERT INTO public.team_notification_reads (notification_id, user_id)
  SELECT n.id, p_actor FROM public.team_notifications n
  WHERE n.id = ANY (p_ids) AND n.status = 'published'
    AND public.role_level(n.min_role::public.app_role) <= public.role_level(v_role)
  ON CONFLICT (notification_id, user_id) DO UPDATE SET read_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

DO $do$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.staff_directory(uuid)',
    'public.staff_find_member(uuid, text)',
    'public.staff_set_role(uuid, uuid, text, text)',
    'public.team_notification_save(uuid, uuid, text, text, text, text, text, boolean, timestamptz, text, text, text)',
    'public.team_notification_mark_read(uuid, uuid[])']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'team_notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.team_notifications;
  END IF;
END $do$;

-- Notices for today ------------------------------------------------------------------------------------------------
INSERT INTO public.team_notifications (title, body, kind, min_role, status, pinned, published_at)
SELECT 'Online payments are now live!',
       'Members can now order online for pickup in store and pay by Card, Instant EFT, Apple Pay or Google Pay.',
       'update', 'budtender', 'published', true, now()
WHERE NOT EXISTS (SELECT 1 FROM public.team_notifications WHERE title = 'Online payments are now live!');

-- Flips by itself at 12AM SAST on 29 October 2026 (22:00 UTC on 28 October); a manager can edit it any time.
INSERT INTO public.team_notifications
  (title, body, kind, min_role, status, pinned, published_at, change_at, change_title, change_body)
SELECT 'Refer-a-friend program goes live on 29 October 2026',
       'The refer-a-friend program for verified members goes live on 29 October 2026.',
       'update', 'budtender', 'published', true, now(),
       '2026-10-28T22:00:00Z'::timestamptz,
       'Refer-a-friend program is now live!',
       'The refer-a-friend program for verified members is now live. Members can refer friends from their account.'
WHERE NOT EXISTS (SELECT 1 FROM public.team_notifications WHERE title LIKE 'Refer-a-friend program%');
