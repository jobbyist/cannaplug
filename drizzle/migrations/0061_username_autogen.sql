-- 29 Oct 2026: every verified member (and every staff member) gets a generated username, which is also their
-- referral code, and may change it once.
--   * profiles.username_auto is true while the username was generated for the member and has not been confirmed or
--     changed by them. member_set_username lets a member replace (or keep) a generated username once; after that it
--     is final, exactly like a username they chose themselves.
--   * _username_generate builds a free name from the first name and the first letter of the surname (for example
--     "thandin"), adding digits if it is taken. _username_assign writes it and audits it.
--   * Existing members whose ID is verified (and staff) are given one now. A member who becomes verified later gets
--     theirs the first time their rewards page loads (member_ensure_username).
--   * member_rewards_summary reports username_auto and can_change so the portal can offer the one change.
-- No DROP and no DELETE in this file.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username_auto boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public._username_generate(p_user uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_first text;
  v_last text;
  v_base text;
  v_try text;
  i integer := 0;
BEGIN
  SELECT lower(regexp_replace(COALESCE(NULLIF(btrim(p.first_name), ''), split_part(btrim(COALESCE(p.full_name, '')), ' ', 1), ''), '[^a-zA-Z0-9]', '', 'g')),
         lower(left(regexp_replace(COALESCE(p.last_name, ''), '[^a-zA-Z0-9]', '', 'g'), 1))
  INTO v_first, v_last FROM public.profiles p WHERE p.id = p_user;
  v_base := left(COALESCE(v_first, ''), 12) || COALESCE(v_last, '');
  IF length(v_base) < 3 THEN v_base := 'member'; END IF;
  v_try := v_base;
  LOOP
    IF v_try ~ '^[a-z0-9_]{3,20}$' AND NOT public._username_reserved(v_try)
       AND NOT EXISTS (SELECT 1 FROM public.profiles x WHERE x.username = v_try) THEN
      RETURN v_try;
    END IF;
    i := i + 1;
    IF i > 300 THEN RAISE EXCEPTION 'username_generation_failed'; END IF;
    v_try := left(v_base, 16) || CASE WHEN i < 60 THEN lpad(floor(random() * 100)::integer::text, 2, '0')
                                      ELSE lpad(floor(random() * 10000)::integer::text, 4, '0') END;
  END LOOP;
END;
$$;

-- Gives a member without a username a generated one. Returns the username (existing or new).
CREATE OR REPLACE FUNCTION public._username_assign(p_user uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_current text;
  v text;
  n integer := 0;
BEGIN
  SELECT p.username INTO v_current FROM public.profiles p WHERE p.id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_current IS NOT NULL THEN RETURN v_current; END IF;
  LOOP
    v := public._username_generate(p_user);
    BEGIN
      UPDATE public.profiles SET username = v, username_auto = true, updated_at = now() WHERE id = p_user;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      n := n + 1;
      IF n > 5 THEN RAISE; END IF;
    END;
  END LOOP;
  PERFORM public._audit(p_user, 'member_username_generated', 'profile', p_user, jsonb_build_object('username', v));
  RETURN v;
END;
$$;

-- Called when the rewards page loads: an eligible member (verified ID, or staff) with no username gets one.
-- It takes no idempotency key because it is idempotent by nature: it only writes while the username is empty, and it
-- is audited when it does (a key per page load would only fill the idempotency table).
CREATE OR REPLACE FUNCTION public.member_ensure_username(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_name text;
BEGIN
  PERFORM public._require_read_committed();
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.username INTO v_name FROM public.profiles p WHERE p.id = p_user_id;
  IF v_name IS NULL AND public._referral_eligible(p_user_id) THEN
    v_name := public._username_assign(p_user_id);
  END IF;
  RETURN jsonb_build_object('username', v_name);
END;
$$;

-- A member sets their username. A username they chose is final; a generated one can be replaced (or kept) once.
CREATE OR REPLACE FUNCTION public.member_set_username(p_user_id uuid, p_username text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v text := lower(btrim(COALESCE(p_username, '')));
  v_status text;
  v_current text;
  v_auto boolean;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'forbidden: sign in to choose a username' USING ERRCODE = '42501';
  END IF;
  v_cached := public._idem_begin('member_username', p_user_id, p_idempotency_key, jsonb_build_object('u', v));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT p.username, p.username_auto INTO v_current, v_auto FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_not_found'; END IF;
  IF v_current IS NOT NULL AND NOT v_auto THEN
    RAISE EXCEPTION 'username_already_set: your username is your referral code, so it cannot be changed';
  END IF;
  IF v_current IS NOT NULL AND v = v_current THEN
    -- Keeping the generated name: it becomes final.
    UPDATE public.profiles SET username_auto = false, updated_at = now() WHERE id = p_user_id;
  ELSE
    v_status := public.username_check(v);
    IF v_status <> 'ok' THEN RAISE EXCEPTION 'username_%: %', v_status, v; END IF;
    BEGIN
      UPDATE public.profiles SET username = v, username_auto = false, updated_at = now() WHERE id = p_user_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'username_taken: %', v;
    END;
  END IF;
  PERFORM public._audit(p_user_id, 'member_username_set', 'profile', p_user_id,
    jsonb_build_object('username', v, 'replaced_generated', v_current IS NOT NULL AND v <> v_current));
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
  v_auto boolean;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT p.username, COALESCE(p.username_auto, false) INTO v_username, v_auto FROM public.profiles p WHERE p.id = p_user_id;
  RETURN jsonb_build_object(
    'username', v_username,
    'username_auto', v_username IS NOT NULL AND v_auto,
    'can_change', v_username IS NOT NULL AND v_auto,
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

-- Existing members with a verified ID (and staff) get a generated username now.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT p.id FROM public.profiles p WHERE p.username IS NULL AND public._referral_eligible(p.id) ORDER BY p.id LOOP
    PERFORM public._username_assign(r.id);
  END LOOP;
END $$;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
      '_username_generate', '_username_assign', 'member_ensure_username', 'member_set_username',
      'member_rewards_summary'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
