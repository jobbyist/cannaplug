-- 30 Oct 2026: merge two username rules in member_set_username.
--   20261029007000_username_autogen lets a member replace (or keep) a GENERATED username once (profiles.username_auto).
--   20261030001000_customer_import lets an IMPORTED member change the username from the file once, after submitting their ID.
--   The import migration was written against the older definition and replaced the generated-username rule, so
--   members with a generated username could no longer change it. This restores it and keeps the imported-member rule:
--   * username_auto = true  -> keep it or replace it once (as before), then it is final.
--   * imported member (linked record, username_edit_used_at not set) with a final username -> one change, only while their
--     ID is pending or verified.
--   * everyone else with a username -> username_already_set, as before.
-- No DROP and no DELETE in this file.

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
  v_imp public.imported_customers;
  v_imported_change boolean := false;
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
    -- A final username: only an imported member has one more change, once, after submitting their ID.
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
    v_imported_change := true;
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
  IF v_imported_change THEN
    UPDATE public.imported_customers SET username_edit_used_at = now() WHERE user_id = p_user_id;
  END IF;
  PERFORM public._audit(p_user_id, CASE WHEN v_imported_change THEN 'member_username_changed' ELSE 'member_username_set' END,
    'profile', p_user_id,
    jsonb_build_object('username', v, 'replaced_generated', v_current IS NOT NULL AND v <> v_current AND NOT v_imported_change)
    || CASE WHEN v_imported_change THEN jsonb_build_object('previous', v_current) ELSE '{}'::jsonb END);
  v_response := jsonb_build_object('username', v);
  RETURN public._idem_finish('member_username', p_user_id, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.member_set_username(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_set_username(uuid, text, text) TO service_role;
