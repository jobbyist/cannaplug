-- 31 Oct 2026: "Ask The Plug" launch announcement. Remembers, per member, which one-time feature announcements they
-- have already seen, so the intro modal shows once per member on any device (not once per browser).
--   * member_feature_seen: one row per (member, feature). RLS is on and browsers have no access; only the server reads
--     and writes it, always for the signed-in member (the actor comes from the verified JWT).
--   * member_feature_mark_seen: records that the member saw an announcement and whether they opened the feature or
--     dismissed it. Idempotent (a double click records once), audited the first time only.
--   * member_features_seen: the feature keys a member has seen (read by the server to decide whether to show it).
-- Stores no health, ID or personal data: a user id, a feature key, a time and "opened"/"dismissed".
-- No DROP and no DELETE in this file.

CREATE TABLE IF NOT EXISTS public.member_feature_seen (
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  feature text NOT NULL CHECK (feature ~ '^[a-z0-9_]{3,60}$'),
  action text NOT NULL CHECK (action IN ('opened', 'dismissed')),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature)
);
ALTER TABLE public.member_feature_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_feature_seen FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.member_feature_seen TO service_role;

CREATE OR REPLACE FUNCTION public.member_feature_mark_seen(
  p_actor uuid, p_feature text, p_action text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_new boolean;
  v_response jsonb;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_actor) THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z0-9_]{3,60}$' THEN RAISE EXCEPTION 'invalid_input: unknown feature'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('opened', 'dismissed') THEN RAISE EXCEPTION 'invalid_input: unknown action'; END IF;

  v_cached := public._idem_begin('member_feature_mark_seen', p_actor, p_idempotency_key,
                                 jsonb_build_object('feature', p_feature, 'action', p_action));
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  -- The first sighting wins: seeing an announcement twice (two tabs) never rewrites what happened the first time.
  INSERT INTO public.member_feature_seen (user_id, feature, action)
  VALUES (p_actor, p_feature, p_action)
  ON CONFLICT (user_id, feature) DO NOTHING;
  v_new := FOUND;
  IF v_new THEN
    PERFORM public._audit(p_actor, 'member_feature_seen', 'member_feature', NULL,
                          jsonb_build_object('feature', p_feature, 'action', p_action));
  END IF;
  v_response := jsonb_build_object('feature', p_feature, 'recorded', v_new);
  RETURN public._idem_finish('member_feature_mark_seen', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.member_features_seen(p_actor uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(array_agg(s.feature ORDER BY s.feature), ARRAY[]::text[])
  FROM public.member_feature_seen s
  WHERE s.user_id = p_actor;
$$;

REVOKE ALL ON FUNCTION public.member_feature_mark_seen(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.member_features_seen(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_feature_mark_seen(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.member_features_seen(uuid) TO service_role;
