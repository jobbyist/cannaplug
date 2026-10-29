-- Rollback for 20261029007000_username_autogen: puts back the 20261029006000 versions of member_set_username and
-- member_rewards_summary (a username is final once set). Generated usernames the member never confirmed or changed
-- are cleared (they never chose them); usernames members chose or changed are kept.
UPDATE public.profiles SET username = NULL WHERE username_auto;
DROP FUNCTION IF EXISTS public.member_ensure_username(uuid);
DROP FUNCTION IF EXISTS public._username_assign(uuid);
DROP FUNCTION IF EXISTS public._username_generate(uuid);
CREATE OR REPLACE FUNCTION public.member_set_username(p_user_id uuid, p_username text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v text := lower(btrim(COALESCE(p_username, '')));
  v_status text;
  v_current text;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'forbidden: sign in to choose a username' USING ERRCODE = '42501';
  END IF;
  v_cached := public._idem_begin('member_username', p_user_id, p_idempotency_key, jsonb_build_object('u', v));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT p.username INTO v_current FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
  IF v_current IS NOT NULL THEN
    RAISE EXCEPTION 'username_already_set: your username is your referral code, so it cannot be changed';
  END IF;
  v_status := public.username_check(v);
  IF v_status <> 'ok' THEN RAISE EXCEPTION 'username_%: %', v_status, v; END IF;
  BEGIN
    UPDATE public.profiles SET username = v, updated_at = now() WHERE id = p_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'username_taken: %', v;
  END;
  PERFORM public._audit(p_user_id, 'member_username_set', 'profile', p_user_id, jsonb_build_object('username', v));
  v_response := jsonb_build_object('username', v);
  RETURN public._idem_finish('member_username', p_user_id, p_idempotency_key, v_response);
END;
$$;
CREATE OR REPLACE FUNCTION public.member_rewards_summary(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_username text;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.username INTO v_username FROM public.profiles p WHERE p.id = p_user_id;
  RETURN jsonb_build_object(
    'username', v_username,
    'can_refer', v_username IS NOT NULL AND public._referral_eligible(p_user_id),
    'referral_points', public.referral_points(),
    'referral_min_spend', public.referral_min_spend(),
    'referred', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'name', COALESCE(NULLIF(btrim(COALESCE(f.first_name, '') || ' ' || COALESCE(left(f.last_name, 1) || '.', '')), ''), 'A friend'),
        'status', r.status, 'joined_at', r.created_at, 'qualified_at', r.qualified_at) ORDER BY r.created_at DESC)
      FROM public.referrals r LEFT JOIN public.profiles f ON f.id = r.referee_id
      WHERE r.referrer_id = p_user_id), '[]'::jsonb),
    'points_from_referrals', COALESCE((SELECT sum(t.points) FROM public.loyalty_transactions t
                                       WHERE t.user_id = p_user_id AND t.source_type = 'referral'), 0),
    'rewards', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name,
                                                             'description', r.description, 'points_cost', r.points_cost)
                                          ORDER BY r.sort_order)
                         FROM public.loyalty_rewards r WHERE r.is_active), '[]'::jsonb));
END;
$$;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS username_auto;
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY['member_set_username', 'member_rewards_summary'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
