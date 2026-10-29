-- Rollback for 20261030002000_customer_import_username_merge: back to the definition from 20261030001000_customer_import
-- (imported members' one change; generated usernames can no longer be replaced). Roll back 20261030001000 as well to
-- return to the autogen definition from 20261029007000.

CREATE OR REPLACE FUNCTION public.member_set_username(p_user_id uuid, p_username text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v text := lower(btrim(COALESCE(p_username, '')));
  v_status text;
  v_current text;
  v_imp public.imported_customers;
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
    SELECT * INTO v_imp FROM public.imported_customers WHERE user_id = p_user_id AND claimed_at IS NOT NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'username_already_set: your username is your referral code, so it cannot be changed';
    END IF;
    IF v_imp.username_edit_used_at IS NOT NULL THEN
      RAISE EXCEPTION 'username_already_set: you have already used your one username change';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.customer_verification cv
                   WHERE cv.user_id = p_user_id AND cv.status IN ('pending', 'verified')) THEN
      RAISE EXCEPTION 'username_edit_needs_id: submit your ID for verification to change your username';
    END IF;
    IF v = v_current THEN RAISE EXCEPTION 'username_unchanged: that is already your username'; END IF;
  END IF;
  v_status := public.username_check(v);
  IF v_status <> 'ok' THEN RAISE EXCEPTION 'username_%: %', v_status, v; END IF;
  BEGIN
    UPDATE public.profiles SET username = v, updated_at = now() WHERE id = p_user_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'username_taken: %', v;
  END;
  IF v_current IS NOT NULL THEN
    UPDATE public.imported_customers SET username_edit_used_at = now() WHERE user_id = p_user_id;
  END IF;
  PERFORM public._audit(p_user_id, CASE WHEN v_current IS NULL THEN 'member_username_set' ELSE 'member_username_changed' END,
    'profile', p_user_id, jsonb_build_object('username', v) || CASE WHEN v_current IS NULL THEN '{}'::jsonb
                                                                    ELSE jsonb_build_object('previous', v_current) END);
  v_response := jsonb_build_object('username', v);
  RETURN public._idem_finish('member_username', p_user_id, p_idempotency_key, v_response);
END;
$$;
