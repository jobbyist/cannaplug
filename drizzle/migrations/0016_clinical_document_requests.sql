-- Document requests: a member asks for a medical letter or a prescription/order, an administrator (or the
-- member) triages the request to a practitioner, and the practitioner fulfils it in the normal workflow.
--
-- A REQUEST IS NOT A DOCUMENT. It carries no clinical content from staff, creates nothing a practitioner has
-- not themselves entered, and a prescription request is only a request to be assessed: the practitioner still
-- authors, reviews and signs everything, and nothing here chooses or suggests a clinical value.
--
--   * Members create requests for themselves (ID-verified members only, at most 3 open at a time) and can
--     cancel their own while still waiting. Their optional note is visible to the member and the assigned
--     practitioner only: administrators never see it.
--   * Administrators do the intake: they can open a request on a member's behalf (phone / in store), assign it
--     to a verified practitioner (a prescription request only to one authorised to prescribe), or decline it.
--     Assigning also records the practitioner-patient assignment the document workflow requires.
--   * The practitioner starts a draft from the request (linking it), or declines it. When the linked document is
--     issued the request is FULFILLED; if the draft is voided the request returns to ASSIGNED.
--   * Same access model as the rest of the system: no client write path, column-limited reads, service-only
--     functions with an explicit actor, audited in audit_log, never deleted.

CREATE TABLE public.document_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (document_type IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER')),
  status text NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'FULFILLED', 'DECLINED', 'CANCELLED')),
  source text NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'admin')),
  doctor_id uuid REFERENCES public.doctor_profiles(id) ON DELETE RESTRICT,
  member_note text CHECK (length(member_note) <= 500),
  admin_reference text CHECK (length(admin_reference) <= 200),
  decision_reason text CHECK (length(decision_reason) <= 500),
  document_id uuid REFERENCES public.medical_documents(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  assigned_by uuid REFERENCES auth.users(id),
  assigned_at timestamptz,
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_requests_doctor_chk CHECK (status NOT IN ('ASSIGNED', 'IN_PROGRESS', 'FULFILLED') OR doctor_id IS NOT NULL),
  CONSTRAINT document_requests_document_chk CHECK (status NOT IN ('IN_PROGRESS', 'FULFILLED') OR document_id IS NOT NULL),
  CONSTRAINT document_requests_declined_chk CHECK (status <> 'DECLINED' OR (decision_reason IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX document_requests_member_idx ON public.document_requests (member_id, created_at DESC);
CREATE INDEX document_requests_doctor_idx ON public.document_requests (doctor_id, status);
CREATE INDEX document_requests_open_idx ON public.document_requests (created_at) WHERE status IN ('REQUESTED', 'ASSIGNED', 'IN_PROGRESS');
CREATE UNIQUE INDEX document_requests_one_per_document_idx ON public.document_requests (document_id) WHERE document_id IS NOT NULL;

CREATE FUNCTION public._document_requests_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW.member_id <> OLD.member_id OR NEW.document_type <> OLD.document_type
     OR NEW.created_by <> OLD.created_by OR NEW.source <> OLD.source
     OR NEW.member_note IS DISTINCT FROM OLD.member_note THEN
    RAISE EXCEPTION 'immutable_record: what was requested cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (CASE OLD.status
      WHEN 'REQUESTED' THEN NEW.status IN ('ASSIGNED', 'DECLINED', 'CANCELLED')
      WHEN 'ASSIGNED' THEN NEW.status IN ('IN_PROGRESS', 'DECLINED', 'CANCELLED')
      WHEN 'IN_PROGRESS' THEN NEW.status IN ('FULFILLED', 'ASSIGNED')
      ELSE false END) THEN
    RAISE EXCEPTION 'invalid_transition: request % -> % is not allowed', OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_requests_guard BEFORE UPDATE ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION public._document_requests_guard();
CREATE TRIGGER document_requests_no_delete BEFORE DELETE ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER document_requests_no_truncate BEFORE TRUNCATE ON public.document_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public._deny_delete();

-- A linked document issuing fulfils the request; a voided draft hands it back to the practitioner's queue.
CREATE FUNCTION public._document_requests_follow_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'ISSUED' THEN
    UPDATE public.document_requests SET status = 'FULFILLED', fulfilled_at = now()
    WHERE document_id = NEW.id AND status = 'IN_PROGRESS';
  ELSIF NEW.status = 'VOID' THEN
    UPDATE public.document_requests SET status = 'ASSIGNED', document_id = NULL
    WHERE document_id = NEW.id AND status = 'IN_PROGRESS';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER medical_documents_requests_follow AFTER UPDATE OF status ON public.medical_documents
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION public._document_requests_follow_document();

ALTER TABLE public.document_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.document_requests TO service_role;
-- The member's note, the administrator's reference and the decision reason are read only through the functions.
GRANT SELECT (id, member_id, document_type, status, source, doctor_id, document_id, assigned_at, decided_at,
              fulfilled_at, created_at, updated_at)
  ON public.document_requests TO authenticated;
CREATE POLICY "member reads own requests" ON public.document_requests FOR SELECT TO authenticated
  USING (member_id = (SELECT auth.uid()));
CREATE POLICY "doctor reads assigned requests" ON public.document_requests FOR SELECT TO authenticated
  USING (doctor_id = public._current_doctor_id());
CREATE POLICY "admin reads request metadata" ON public.document_requests FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public._request_member_ok(p_member uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.customer_verification WHERE user_id = p_member AND status = 'verified') THEN
    RAISE EXCEPTION 'member_not_verified: the member''s identity must be verified first';
  END IF;
  IF (SELECT count(*) FROM public.document_requests
      WHERE member_id = p_member AND status IN ('REQUESTED', 'ASSIGNED', 'IN_PROGRESS')) >= 3 THEN
    RAISE EXCEPTION 'too_many_requests: there are already three open requests — wait for one to be completed or cancel it';
  END IF;
END;
$$;

-- Member asks for a document for themselves.
CREATE FUNCTION public.request_create(p_actor uuid, p_type text, p_note text, p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_id uuid;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM public._require_read_committed();
  IF p_actor IS NULL THEN RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501'; END IF;
  IF p_type NOT IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER') THEN RAISE EXCEPTION 'invalid_input: document type'; END IF;
  IF v_note IS NOT NULL AND (length(v_note) > 500 OR v_note ~ '[<>]' OR v_note ~ '[\x00-\x08\x0B\x0C\x0E-\x1F]') THEN
    RAISE EXCEPTION 'invalid_input: the note is too long or contains characters that are not allowed';
  END IF;
  v_cached := public._idem_begin('req_create', p_actor, p_idempotency_key, jsonb_build_object('t', p_type, 'n', v_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  PERFORM public._request_member_ok(p_actor);
  INSERT INTO public.document_requests (member_id, document_type, source, member_note, created_by)
  VALUES (p_actor, p_type, 'member', v_note, p_actor) RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'document_request_created', 'document_request', v_id,
    jsonb_build_object('document_type', p_type, 'source', 'member'));
  RETURN public._idem_finish('req_create', p_actor, p_idempotency_key, jsonb_build_object('id', v_id, 'status', 'REQUESTED'));
END;
$$;

CREATE FUNCTION public.request_cancel(p_actor uuid, p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.document_requests;
BEGIN
  SELECT * INTO r FROM public.document_requests WHERE id = p_request AND member_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF r.status NOT IN ('REQUESTED', 'ASSIGNED') THEN
    RAISE EXCEPTION 'invalid_transition: a request that is % cannot be cancelled', r.status;
  END IF;
  UPDATE public.document_requests SET status = 'CANCELLED', decided_by = p_actor, decided_at = now() WHERE id = p_request;
  PERFORM public._audit(p_actor, 'document_request_cancelled', 'document_request', p_request, '{}'::jsonb);
  RETURN jsonb_build_object('id', p_request, 'status', 'CANCELLED');
END;
$$;

CREATE FUNCTION public.request_assign(p_actor uuid, p_request uuid, p_doctor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.document_requests;
  d public.doctor_profiles;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  SELECT * INTO r FROM public.document_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF r.status NOT IN ('REQUESTED', 'ASSIGNED') THEN
    RAISE EXCEPTION 'invalid_transition: a request that is % cannot be assigned', r.status;
  END IF;
  SELECT * INTO d FROM public.doctor_profiles WHERE id = p_doctor;
  IF NOT FOUND OR NOT d.is_active OR d.verification_status <> 'verified' THEN
    RAISE EXCEPTION 'invalid_input: choose a verified, active practitioner';
  END IF;
  IF r.document_type = 'PRESCRIPTION_ORDER' AND NOT d.prescribing_authorised THEN
    RAISE EXCEPTION 'invalid_input: that practitioner is not authorised to issue prescriptions';
  END IF;
  IF d.user_id = r.member_id THEN RAISE EXCEPTION 'invalid_input: a practitioner cannot be their own patient'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customer_verification WHERE user_id = r.member_id AND status = 'verified') THEN
    RAISE EXCEPTION 'member_not_verified: the member''s identity must be verified first';
  END IF;
  INSERT INTO public.doctor_patient_assignments (doctor_id, member_id, assigned_by)
  VALUES (p_doctor, r.member_id, p_actor) ON CONFLICT DO NOTHING;
  UPDATE public.document_requests SET status = 'ASSIGNED', doctor_id = p_doctor, assigned_by = p_actor, assigned_at = now()
  WHERE id = p_request;
  PERFORM public._audit(p_actor, 'document_request_assigned', 'document_request', p_request,
    jsonb_build_object('doctor_id', p_doctor));
  RETURN jsonb_build_object('id', p_request, 'status', 'ASSIGNED');
END;
$$;

-- Administrator opens a request on a member's behalf (phone, in store). The note is an administrative
-- reference only; it must not carry clinical information, and it is never shown to the practitioner as a
-- clinical statement.
CREATE FUNCTION public.request_admin_create(
  p_actor uuid, p_member uuid, p_type text, p_doctor uuid, p_reference text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_id uuid;
  v_ref text := NULLIF(btrim(COALESCE(p_reference, '')), '');
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  IF p_type NOT IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER') THEN RAISE EXCEPTION 'invalid_input: document type'; END IF;
  IF v_ref IS NOT NULL AND (length(v_ref) > 200 OR v_ref ~ '[<>]' OR v_ref ~ '[\x00-\x08\x0B\x0C\x0E-\x1F]') THEN
    RAISE EXCEPTION 'invalid_input: the reference is too long or contains characters that are not allowed';
  END IF;
  v_cached := public._idem_begin('req_admin_create', p_actor, p_idempotency_key,
    jsonb_build_object('m', p_member, 't', p_type, 'd', p_doctor, 'r', v_ref));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_member) THEN RAISE EXCEPTION 'member_not_found'; END IF;
  PERFORM public._request_member_ok(p_member);
  INSERT INTO public.document_requests (member_id, document_type, source, admin_reference, created_by)
  VALUES (p_member, p_type, 'admin', v_ref, p_actor) RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'document_request_created', 'document_request', v_id,
    jsonb_build_object('document_type', p_type, 'source', 'admin'));
  IF p_doctor IS NOT NULL THEN PERFORM public.request_assign(p_actor, v_id, p_doctor); END IF;
  RETURN public._idem_finish('req_admin_create', p_actor, p_idempotency_key,
    jsonb_build_object('id', v_id, 'status', CASE WHEN p_doctor IS NULL THEN 'REQUESTED' ELSE 'ASSIGNED' END));
END;
$$;

-- Decline: an administrator (not yet started) or the assigned practitioner (not while a draft exists).
CREATE FUNCTION public.request_decline(p_actor uuid, p_request uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.document_requests;
  d public.doctor_profiles;
  v_role text;
BEGIN
  SELECT * INTO r FROM public.document_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor AND is_active;
  IF FOUND AND d.id = r.doctor_id THEN
    v_role := 'doctor';
  ELSE
    PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
    v_role := 'admin';
  END IF;
  IF r.status NOT IN ('REQUESTED', 'ASSIGNED') THEN
    RAISE EXCEPTION 'invalid_transition: a request that is % cannot be declined (void the draft first)', r.status;
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 OR length(p_reason) > 500 OR p_reason ~ '[<>]' THEN
    RAISE EXCEPTION 'invalid_input: a reason of 3-500 characters is required';
  END IF;
  UPDATE public.document_requests SET status = 'DECLINED', decision_reason = btrim(p_reason), decided_by = p_actor, decided_at = now()
  WHERE id = p_request;
  PERFORM public._audit(p_actor, 'document_request_declined', 'document_request', p_request, jsonb_build_object('by', v_role));
  RETURN jsonb_build_object('id', p_request, 'status', 'DECLINED');
END;
$$;

-- The practitioner starts a draft from the request.
CREATE FUNCTION public.request_link_document(p_actor uuid, p_request uuid, p_doc uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r public.document_requests;
  d public.doctor_profiles;
  doc public.medical_documents;
BEGIN
  d := public._require_doctor(p_actor, false);
  SELECT * INTO r FROM public.document_requests WHERE id = p_request FOR UPDATE;
  IF NOT FOUND OR r.doctor_id IS DISTINCT FROM d.id THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF r.status <> 'ASSIGNED' THEN RAISE EXCEPTION 'invalid_transition: the request is %', r.status; END IF;
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc;
  IF NOT FOUND OR doc.doctor_id <> d.id OR doc.member_id <> r.member_id OR doc.document_type <> r.document_type
     OR doc.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'invalid_input: that draft does not match the request';
  END IF;
  UPDATE public.document_requests SET status = 'IN_PROGRESS', document_id = p_doc WHERE id = p_request;
  RETURN jsonb_build_object('id', p_request, 'status', 'IN_PROGRESS');
END;
$$;

-- Lists. Each returns only what that audience may see.
CREATE FUNCTION public.request_list_member(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'document_type', r.document_type, 'status', r.status, 'source', r.source,
    'created_at', r.created_at, 'decision_reason', r.decision_reason, 'member_note', r.member_note,
    'practitioner', CASE WHEN dp.id IS NULL THEN NULL ELSE btrim(dp.title || ' ' || dp.first_name || ' ' || dp.last_name) END)
    ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM public.document_requests r LEFT JOIN public.doctor_profiles dp ON dp.id = r.doctor_id
  WHERE r.member_id = p_user;
$$;

-- Administrator queue: who asked for what and where it stands. Never the member's note.
CREATE FUNCTION public.request_list_admin(p_actor uuid, p_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  RETURN COALESCE((
    SELECT jsonb_agg(j ORDER BY (j ->> 'created_at') DESC) FROM (
      SELECT jsonb_build_object(
        'id', r.id, 'document_type', r.document_type, 'status', r.status, 'source', r.source,
        'member_id', r.member_id, 'member_name', pr.full_name, 'member_ref', public._member_ref(r.member_id),
        'doctor_id', r.doctor_id,
        'practitioner', CASE WHEN dp.id IS NULL THEN NULL ELSE btrim(dp.title || ' ' || dp.first_name || ' ' || dp.last_name) END,
        'admin_reference', r.admin_reference, 'decision_reason', r.decision_reason, 'created_at', r.created_at) AS j
      FROM public.document_requests r
      JOIN public.profiles pr ON pr.id = r.member_id
      LEFT JOIN public.doctor_profiles dp ON dp.id = r.doctor_id
      WHERE p_status IS NULL OR r.status = p_status
      ORDER BY r.created_at DESC LIMIT 300) x), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.request_list_doctor(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
BEGIN
  d := public._require_doctor(p_actor, false);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'document_type', r.document_type, 'status', r.status, 'member_id', r.member_id,
      'member_ref', public._member_ref(r.member_id), 'patient', pr.full_name, 'member_note', r.member_note,
      'admin_reference', r.admin_reference, 'created_at', r.created_at, 'document_id', r.document_id)
      ORDER BY r.created_at DESC)
    FROM public.document_requests r JOIN public.profiles pr ON pr.id = r.member_id
    WHERE r.doctor_id = d.id AND r.status IN ('ASSIGNED', 'IN_PROGRESS')), '[]'::jsonb);
END;
$$;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'request\_%' OR p.proname IN ('_request_member_ok', '_document_requests_guard', '_document_requests_follow_document'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;
