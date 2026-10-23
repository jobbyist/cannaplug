-- Prompt 9 (23 Oct 2026): the clinical pipeline tells people when to act, budtenders can see that an order is covered by
-- a valid prescription without seeing clinical content, practitioners get a searchable portal, and administrators get
-- a readiness checklist. Every existing clinical guard is kept; nothing here reads or writes a clinical value.
--
--   * notifications       content-free emails (and push, via the queue's fan-out) on request assigned / completed /
--                         declined and document waiting / issued / revoked. Template data is EMPTY: no type, no
--                         practitioner, no member name, no medicine.
--   * order_prescription_links  member links their own ISSUED, unexpired, unrevoked prescription to their own open
--                         order; staff see only number + valid-until + a verify link. Revoking flags linked open orders.
--   * doctor_search_documents   paged search for /doctor (the header's "Waiting for you" count uses the existing lists).
--   * clinical_readiness  what still blocks issuing, for /admin.

-- ---------------------------------------------------------------------------
-- Notifications (best effort: never block a clinical transition)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._clinical_notify_user(p_user uuid, p_template text, p_dedupe text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text;
BEGIN
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_user;
  IF v_email IS NULL THEN RETURN; END IF;
  PERFORM public.notification_enqueue('email', p_template, v_email, p_user, 'transactional', '{}'::jsonb, p_dedupe);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'clinical notification skipped: %', SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION public._document_requests_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_doctor_user uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.doctor_id IS NOT DISTINCT FROM OLD.doctor_id THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'ASSIGNED' AND NEW.doctor_id IS NOT NULL THEN
    SELECT dp.user_id INTO v_doctor_user FROM public.doctor_profiles dp WHERE dp.id = NEW.doctor_id;
    PERFORM public._clinical_notify_user(v_doctor_user, 'practitioner_request_assigned',
      'clin:req:' || NEW.id::text || ':assigned:' || NEW.doctor_id::text);
  ELSIF NEW.status = 'FULFILLED' THEN
    PERFORM public._clinical_notify_user(NEW.member_id, 'clinical_request_completed', 'clin:req:' || NEW.id::text || ':done');
  ELSIF NEW.status = 'DECLINED' THEN
    PERFORM public._clinical_notify_user(NEW.member_id, 'clinical_request_declined', 'clin:req:' || NEW.id::text || ':declined');
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER document_requests_notify AFTER INSERT OR UPDATE OF status, doctor_id ON public.document_requests
  FOR EACH ROW EXECUTE FUNCTION public._document_requests_notify();

-- ---------------------------------------------------------------------------
-- Prescription → order link
-- ---------------------------------------------------------------------------

CREATE TABLE public.order_prescription_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
  prescription_id uuid NOT NULL REFERENCES public.prescription_orders(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'flagged')),
  flagged_reason text CHECK (flagged_reason IS NULL OR length(flagged_reason) <= 200),
  linked_by uuid NOT NULL REFERENCES auth.users(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  flagged_at timestamptz
);
CREATE INDEX order_prescription_links_rx_idx ON public.order_prescription_links (prescription_id);
ALTER TABLE public.order_prescription_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_prescription_links FROM anon, authenticated;
GRANT ALL ON public.order_prescription_links TO service_role;

CREATE OR REPLACE FUNCTION public.link_prescription_to_order(
  p_actor uuid, p_order_id uuid, p_prescription_id uuid, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_order public.orders;
  v_rx public.prescription_orders;
  v_doc public.medical_documents;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_actor IS NULL THEN RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501'; END IF;
  v_cached := public._idem_begin('link_prescription_to_order', p_actor, p_idempotency_key,
    jsonb_build_object('order', p_order_id, 'rx', p_prescription_id));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_order.user_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v_order.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'order_closed: a prescription can only be linked to an open order';
  END IF;
  SELECT * INTO v_rx FROM public.prescription_orders WHERE id = p_prescription_id;
  IF NOT FOUND OR v_rx.member_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'prescription_not_found'; END IF;
  SELECT * INTO v_doc FROM public.medical_documents WHERE id = v_rx.document_id;
  IF v_doc.document_type <> 'PRESCRIPTION_ORDER' OR v_doc.status <> 'ISSUED' OR v_doc.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'prescription_not_valid: only an issued, unrevoked prescription can be linked';
  END IF;
  IF v_doc.expires_at IS NULL OR v_doc.expires_at <= now() THEN
    RAISE EXCEPTION 'prescription_expired: this prescription is no longer valid';
  END IF;

  INSERT INTO public.order_prescription_links (order_id, prescription_id, member_id, linked_by)
  VALUES (p_order_id, p_prescription_id, p_actor, p_actor)
  ON CONFLICT (order_id) DO UPDATE
    SET prescription_id = EXCLUDED.prescription_id, status = 'active', flagged_reason = NULL, flagged_at = NULL,
        linked_by = EXCLUDED.linked_by, linked_at = now();
  PERFORM public._audit(p_actor, 'prescription_linked_to_order', 'order', p_order_id,
    jsonb_build_object('document_number', v_doc.document_id));
  v_response := jsonb_build_object('order_id', p_order_id, 'document_number', v_doc.document_id,
    'valid_until', v_doc.expires_at);
  RETURN public._idem_finish('link_prescription_to_order', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Staff view (budtender+): number, validity and a verify token. No clinical column is read or returned.
CREATE OR REPLACE FUNCTION public.order_prescription_summaries(p_actor uuid, p_order_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  RETURN COALESCE((
    SELECT jsonb_object_agg(l.order_id::text, jsonb_build_object(
      'document_number', md.document_id,
      'valid_until', md.expires_at,
      'verify_token', md.verification_token,
      'link_status', l.status,
      'valid', md.status = 'ISSUED' AND md.revoked_at IS NULL AND md.expires_at > now() AND l.status = 'active'))
    FROM public.order_prescription_links l
    JOIN public.prescription_orders po ON po.id = l.prescription_id
    JOIN public.medical_documents md ON md.id = po.document_id
    WHERE l.order_id = ANY (COALESCE(p_order_ids, '{}'))), '{}'::jsonb);
END;
$$;

-- The member's own issued, valid prescriptions to choose from (number and validity only).
CREATE OR REPLACE FUNCTION public.member_linkable_prescriptions(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('prescription_id', po.id, 'document_number', md.document_id,
                                        'valid_until', md.expires_at) ORDER BY md.issued_at DESC)
    FROM public.prescription_orders po JOIN public.medical_documents md ON md.id = po.document_id
    WHERE po.member_id = p_actor AND md.member_id = p_actor AND md.document_type = 'PRESCRIPTION_ORDER'
      AND md.status = 'ISSUED' AND md.revoked_at IS NULL AND md.expires_at > now()), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public._medical_documents_notify()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_doctor_user uuid;
  r record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status IN ('PENDING_DOCTOR_REVIEW', 'APPROVED') THEN
    SELECT dp.user_id INTO v_doctor_user FROM public.doctor_profiles dp WHERE dp.id = NEW.doctor_id;
    PERFORM public._clinical_notify_user(v_doctor_user, 'practitioner_document_waiting',
      'clin:doc:' || NEW.id::text || ':' || lower(NEW.status));
  ELSIF NEW.status = 'ISSUED' THEN
    PERFORM public._clinical_notify_user(NEW.member_id, 'document_ready', 'clin:doc:' || NEW.id::text || ':issued');
  ELSIF NEW.status = 'REVOKED' THEN
    PERFORM public._clinical_notify_user(NEW.member_id, 'document_revoked', 'clin:doc:' || NEW.id::text || ':revoked');
    -- Open orders that relied on this prescription need a person to look before they are packed.
    BEGIN
      FOR r IN
        UPDATE public.order_prescription_links l
        SET status = 'flagged', flagged_reason = 'prescription revoked', flagged_at = now()
        FROM public.prescription_orders po, public.orders o
        WHERE po.document_id = NEW.id AND l.prescription_id = po.id AND o.id = l.order_id
          AND o.status NOT IN ('completed', 'cancelled') AND l.status = 'active'
        RETURNING l.order_id, o.order_number
      LOOP
        PERFORM public.notification_enqueue_staff('staff_prescription_revoked',
          jsonb_build_object('order_id', r.order_id, 'order_number', r.order_number),
          'rxrevoked:' || r.order_id::text, 'budtender'::public.app_role);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'prescription link flagging skipped: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER medical_documents_notify AFTER UPDATE OF status ON public.medical_documents
  FOR EACH ROW EXECUTE FUNCTION public._medical_documents_notify();

-- ---------------------------------------------------------------------------
-- Practitioner portal: paged search
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.doctor_search_documents(
  p_actor uuid, p_query text DEFAULT NULL, p_status text DEFAULT NULL, p_type text DEFAULT NULL,
  p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  v_q text := NULLIF(btrim(COALESCE(p_query, '')), '');
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden: practitioner profile required' USING ERRCODE = '42501'; END IF;
  IF v_q IS NOT NULL AND length(v_q) > 80 THEN RAISE EXCEPTION 'invalid_input: search is too long'; END IF;
  RETURN (
    WITH base AS (
      SELECT md.id, md.document_id, md.document_type, md.member_id, md.created_at, md.issued_at, md.expires_at,
             md.template_version, md.document_version, pr.full_name AS patient,
             CASE WHEN md.status = 'ISSUED' AND md.expires_at IS NOT NULL AND md.expires_at <= now() THEN 'EXPIRED'
                  ELSE md.status END AS status
      FROM public.medical_documents md JOIN public.profiles pr ON pr.id = md.member_id
      WHERE md.doctor_id = d.id
    ), f AS (
      SELECT * FROM base
      WHERE (p_status IS NULL OR status = p_status)
        AND (p_type IS NULL OR document_type = p_type)
        AND (p_from IS NULL OR created_at >= p_from)
        AND (p_to IS NULL OR created_at < p_to + 1)
        AND (v_q IS NULL OR document_id ILIKE '%' || v_q || '%' OR patient ILIKE '%' || v_q || '%')
    )
    SELECT jsonb_build_object(
      'total', (SELECT count(*) FROM f),
      'limit', v_limit, 'offset', v_offset,
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
                        FROM (SELECT * FROM f ORDER BY created_at DESC LIMIT v_limit OFFSET v_offset) x), '[]'::jsonb)));
END;
$$;

-- ---------------------------------------------------------------------------
-- Administrator readiness checklist (what still blocks issuing). Secrets are checked by the app, not here.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.clinical_readiness(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  RETURN jsonb_build_object(
    'verified_practitioners', (SELECT count(*) FROM public.doctor_profiles
                               WHERE verification_status = 'verified' AND is_active),
    'prescribing_practitioners', (SELECT count(*) FROM public.doctor_profiles
                                  WHERE verification_status = 'verified' AND is_active AND prescribing_authorised),
    'active_templates', (SELECT jsonb_object_agg(t, n) FROM (
        SELECT dt.t, count(x.id) AS n
        FROM (VALUES ('MEDICAL_LETTER'), ('PRESCRIPTION_ORDER')) dt(t)
        LEFT JOIN public.document_templates x ON x.document_type = dt.t AND x.status = 'ACTIVE'
        GROUP BY dt.t) s),
    'draft_templates', (SELECT count(*) FROM public.document_templates WHERE status IN ('DRAFT', 'PENDING_APPROVAL')),
    'policy_confirmed', (SELECT jsonb_object_agg(document_type, confirmed_at IS NOT NULL)
                         FROM public.document_signature_policy),
    'providers_enabled', (SELECT count(*) FROM public.signature_providers WHERE enabled));
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._clinical_notify_user(uuid, text, text)',
    'public._document_requests_notify()',
    'public._medical_documents_notify()',
    'public.link_prescription_to_order(uuid, uuid, uuid, text)',
    'public.order_prescription_summaries(uuid, uuid[])',
    'public.member_linkable_prescriptions(uuid)',
    'public.doctor_search_documents(uuid, text, text, text, date, date, integer, integer)',
    'public.clinical_readiness(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;
