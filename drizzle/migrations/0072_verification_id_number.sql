-- 5 Nov 2026: the ID / passport number moves from sign-up to the ID verification step (staff feedback: sign-up
-- was too long). Sign-up now asks only for name, email, password and date of birth; the number is entered next
-- to the ID photo, where members expect it.
--
--   * verification_record_id_number(user, number, dob, key)   service role only. Cleans and checks the number
--     (a 13-digit SA ID must pass the Luhn checksum and match the date of birth; anything else must look like a
--     passport number), then stores it in member_signup_details. A number already on file is never replaced, so
--     a member cannot swap the number staff already checked. The audit row records only that a number was
--     stored, never the number itself, and the idempotency row hashes no part of it.
--   * handle_new_user is unchanged: an older browser that still sends id_number at sign-up keeps working.

CREATE OR REPLACE FUNCTION public.verification_record_id_number(
  p_user_id uuid,
  p_id_number text,
  p_dob date,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id text := upper(regexp_replace(COALESCE(p_id_number, ''), '[\s-]', '', 'g'));
  v_cached jsonb;
  v_sum integer := 0;
  v_digit integer;
  v_existing text;
  v_response jsonb;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'unknown_member: sign in again and retry';
  END IF;
  -- The request hash covers no part of the number: an ID number is short enough to guess from its hash.
  v_cached := public._idem_begin('id_number', p_user_id, p_idempotency_key, '{}'::jsonb);
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  IF v_id ~ '^\d{13}$' THEN
    FOR i IN 0..12 LOOP
      v_digit := substr(v_id, 13 - i, 1)::integer;
      IF i % 2 = 1 THEN
        v_digit := v_digit * 2;
        IF v_digit > 9 THEN v_digit := v_digit - 9; END IF;
      END IF;
      v_sum := v_sum + v_digit;
    END LOOP;
    IF v_sum % 10 <> 0 THEN
      RAISE EXCEPTION 'invalid_id_number: that ID number doesn''t look right — check it and try again';
    END IF;
    IF p_dob IS NOT NULL AND substr(v_id, 1, 6) <> to_char(p_dob, 'YYMMDD') THEN
      RAISE EXCEPTION 'id_dob_mismatch: your ID number and date of birth don''t match — check both';
    END IF;
  ELSIF v_id !~ '^[A-Z0-9]{6,20}$' THEN
    RAISE EXCEPTION 'invalid_id_number: enter a 13-digit ID number or a passport number';
  END IF;

  SELECT d.id_number INTO v_existing FROM public.member_signup_details d WHERE d.user_id = p_user_id FOR UPDATE;
  IF v_existing IS NULL THEN
    INSERT INTO public.member_signup_details (user_id, id_number) VALUES (p_user_id, v_id)
    ON CONFLICT (user_id) DO UPDATE SET id_number = EXCLUDED.id_number
      WHERE public.member_signup_details.id_number IS NULL;
    INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, target_user_id, metadata)
    VALUES (p_user_id, 'id_number_recorded', 'member_signup_details', p_user_id, p_user_id,
            jsonb_build_object('kind', CASE WHEN v_id ~ '^\d{13}$' THEN 'sa_id' ELSE 'passport' END));
    v_response := jsonb_build_object('stored', true);
  ELSE
    v_response := jsonb_build_object('stored', false, 'already_on_file', true);
  END IF;

  RETURN public._idem_finish('id_number', p_user_id, p_idempotency_key, v_response);
END;
$$;

REVOKE ALL ON FUNCTION public.verification_record_id_number(uuid, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verification_record_id_number(uuid, text, date, text) TO service_role;
