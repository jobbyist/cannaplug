-- 26 Oct 2026: budtenders can review member IDs (owner's decision).
--   verification_log_document_view and verification_review now need budtender (was manager). Everything else is
--   unchanged: nobody reviews their own ID, under-18 and expired documents cannot be approved, every document view is
--   written to the audit log before the 60-second link is made, and only an admin can reset a locked-out member.

CREATE OR REPLACE FUNCTION public.verification_log_document_view(p_actor uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.customer_verification;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  SELECT * INTO v_row FROM public.customer_verification WHERE user_id = p_user_id;
  IF NOT FOUND OR v_row.document_path IS NULL THEN
    RAISE EXCEPTION 'verification_not_found';
  END IF;
  INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, target_user_id, metadata)
  VALUES (p_actor, 'id_document_viewed', 'customer_verification', p_user_id, p_user_id,
          jsonb_build_object('document_type', v_row.document_type, 'status', v_row.status));
  RETURN jsonb_build_object('path', v_row.document_path, 'document_type', v_row.document_type);
END;
$function$;

CREATE OR REPLACE FUNCTION public.verification_review(p_actor uuid, p_user_id uuid, p_decision text, p_rejection_code text, p_note text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_cached jsonb;
  v_row public.customer_verification;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  IF p_actor = p_user_id THEN
    RAISE EXCEPTION 'self_review_forbidden: another staff member must review your own ID' USING ERRCODE = '42501';
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
    IF v_row.declared_dob > (current_date - interval '18 years')::date THEN
      RAISE EXCEPTION 'underage: the member is under 18 — reject this ID';
    END IF;
    IF v_row.document_expires_on IS NOT NULL AND v_row.document_expires_on < current_date THEN
      RAISE EXCEPTION 'document_expired: the document has expired — reject this ID';
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
$function$;
