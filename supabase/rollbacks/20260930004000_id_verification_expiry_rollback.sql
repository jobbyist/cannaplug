-- Rollback for 20260930004000_id_verification_expiry.sql.
-- Restores the 20260930003000 definitions of _require_verified_member / verification_submit /
-- verification_review and removes the expiry column and its constraints. Any expiry dates recorded in the
-- meantime are lost; verified members with an expired passport / licence become verified again.

BEGIN;

DROP FUNCTION IF EXISTS public.verification_submit(uuid, text, text, date, date, text);

CREATE OR REPLACE FUNCTION public._require_verified_member(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT cv.status INTO v_status FROM public.customer_verification cv WHERE cv.user_id = p_user_id;
  IF v_status = 'verified' THEN
    RETURN;
  ELSIF v_status = 'pending' THEN
    RAISE EXCEPTION 'verification_pending: your ID is being reviewed — you can order once it is approved';
  END IF;
  RAISE EXCEPTION 'verification_required: verify your ID before placing an order';
END;
$$;

CREATE OR REPLACE FUNCTION public.verification_submit(
  p_user_id uuid,
  p_document_type text,
  p_document_path text,
  p_dob date,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_attempts constant integer := 5;
  v_cached jsonb;
  v_row public.customer_verification;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_cached := public._idem_begin('id_submit', p_user_id, p_idempotency_key,
    jsonb_build_object('type', p_document_type, 'path', p_document_path, 'dob', p_dob));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  IF p_document_type IS NULL OR p_document_type NOT IN ('sa_id', 'passport', 'drivers_licence') THEN
    RAISE EXCEPTION 'invalid_document_type: choose the type of document you are uploading';
  END IF;
  -- The file must sit in the member's own folder and look like something we minted an upload URL for.
  IF p_document_path IS NULL
     OR p_document_path !~ ('^' || p_user_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$') THEN
    RAISE EXCEPTION 'invalid_document_path: upload your ID again';
  END IF;
  IF p_dob IS NULL OR p_dob < (current_date - interval '120 years')::date OR p_dob > current_date THEN
    RAISE EXCEPTION 'invalid_dob: enter your date of birth';
  END IF;
  IF p_dob > (current_date - interval '18 years')::date THEN
    RAISE EXCEPTION 'underage: you must be 18 or older to shop with CannaPlug';
  END IF;

  INSERT INTO public.customer_verification (user_id, status) VALUES (p_user_id, 'unverified')
  ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_row FROM public.customer_verification WHERE user_id = p_user_id FOR UPDATE;

  IF v_row.status = 'verified' THEN
    RAISE EXCEPTION 'already_verified: your ID is already verified';
  ELSIF v_row.status = 'pending' THEN
    RAISE EXCEPTION 'verification_pending: your ID is already being reviewed';
  ELSIF v_row.attempt_count >= c_max_attempts THEN
    RAISE EXCEPTION 'too_many_attempts: please contact CannaPlug support to continue';
  END IF;

  UPDATE public.customer_verification
  SET status = 'pending', document_type = p_document_type, document_path = p_document_path,
      declared_dob = p_dob, submitted_at = now(), attempt_count = attempt_count + 1,
      reviewed_at = NULL, reviewed_by = NULL, rejection_code = NULL, rejection_note = NULL,
      verified_at = NULL, verified_by = NULL, method = NULL, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, target_user_id, metadata)
  VALUES (p_user_id, 'id_verification_submitted', 'customer_verification', p_user_id, p_user_id,
          jsonb_build_object('document_type', p_document_type, 'attempt', v_row.attempt_count + 1));

  v_response := jsonb_build_object('status', 'pending', 'attempt', v_row.attempt_count + 1);
  RETURN public._idem_finish('id_submit', p_user_id, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.verification_review(
  p_actor uuid,
  p_user_id uuid,
  p_decision text,
  p_rejection_code text,
  p_note text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_row public.customer_verification;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  IF p_actor = p_user_id THEN
    RAISE EXCEPTION 'self_review_forbidden: another manager must review your own ID' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'invalid_decision';
  END IF;
  IF p_decision = 'reject' THEN
    IF p_rejection_code IS NULL
       OR p_rejection_code NOT IN ('unreadable', 'expired_document', 'name_mismatch', 'dob_mismatch', 'underage', 'other') THEN
      RAISE EXCEPTION 'rejection_reason_required: choose why the ID is being rejected';
    END IF;
    IF p_rejection_code = 'other' AND v_note IS NULL THEN
      RAISE EXCEPTION 'rejection_reason_required: add a note explaining the rejection';
    END IF;
    IF v_note IS NOT NULL AND length(v_note) > 500 THEN
      RAISE EXCEPTION 'rejection_note_too_long';
    END IF;
  END IF;

  v_cached := public._idem_begin('id_review', p_actor, p_idempotency_key,
    jsonb_build_object('user', p_user_id, 'decision', p_decision, 'code', p_rejection_code, 'note', v_note));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_row FROM public.customer_verification WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification_not_found';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'not_pending: this ID is not waiting for review (it is %)', v_row.status;
  END IF;

  IF p_decision = 'approve' THEN
    -- Re-check the age rule at decision time: the declared date is what the reviewer compared to the ID.
    IF v_row.declared_dob > (current_date - interval '18 years')::date THEN
      RAISE EXCEPTION 'underage: the member is under 18 — reject this ID';
    END IF;
    UPDATE public.customer_verification
    SET status = 'verified', method = 'manual_id_review', verified_at = now(), verified_by = p_actor,
        reviewed_at = now(), reviewed_by = p_actor, rejection_code = NULL, rejection_note = NULL,
        updated_at = now()
    WHERE user_id = p_user_id;
    UPDATE public.profiles SET date_of_birth = v_row.declared_dob, updated_at = now() WHERE id = p_user_id;
  ELSE
    UPDATE public.customer_verification
    SET status = 'rejected', reviewed_at = now(), reviewed_by = p_actor, rejection_code = p_rejection_code,
        rejection_note = v_note, verified_at = NULL, verified_by = NULL, updated_at = now()
    WHERE user_id = p_user_id;
  END IF;

  INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, target_user_id, metadata)
  VALUES (p_actor, CASE p_decision WHEN 'approve' THEN 'id_verification_approved' ELSE 'id_verification_rejected' END,
          'customer_verification', p_user_id, p_user_id,
          jsonb_build_object('attempt', v_row.attempt_count, 'rejection_code', p_rejection_code));

  v_response := jsonb_build_object('user_id', p_user_id,
    'status', CASE p_decision WHEN 'approve' THEN 'verified' ELSE 'rejected' END);
  RETURN public._idem_finish('id_review', p_actor, p_idempotency_key, v_response);
END;
$$;

ALTER TABLE public.customer_verification
  DROP CONSTRAINT IF EXISTS customer_verification_sa_id_no_expiry_chk,
  DROP CONSTRAINT IF EXISTS customer_verification_expiry_required_chk,
  DROP COLUMN IF EXISTS document_expires_on;


DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY['_require_verified_member', 'verification_submit', 'verification_review'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;

COMMIT;
