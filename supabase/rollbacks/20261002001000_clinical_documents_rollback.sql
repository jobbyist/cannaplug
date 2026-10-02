-- Rollback for 20261002001000_clinical_documents.
--
-- DESTRUCTIVE: this removes every clinical document, prescription, signature record, audit event and
-- verification record. Clinical records are subject to legal retention, so the script refuses to run if any
-- document exists, and requires two explicit confirmations otherwise. Prefer revoking documents and
-- disabling the feature (leave the signature providers disabled) over rolling back.
--
--   SET app.confirm_rollback = 'yes';
--   SET app.confirm_clinical_data_loss = 'yes';   -- only ever needed if documents exist, and only with counsel's sign-off

BEGIN;

DO $$
BEGIN
  IF current_setting('app.confirm_rollback', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Rollback requires: SET app.confirm_rollback = ''yes'';';
  END IF;
  IF EXISTS (SELECT 1 FROM public.medical_documents)
     AND current_setting('app.confirm_clinical_data_loss', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Clinical documents exist. Rolling back would destroy legally retained records. Refusing.';
  END IF;
END
$$;

-- The immutability triggers deliberately block deletes; disable them for this one transaction.
ALTER TABLE public.document_events DISABLE TRIGGER USER;
ALTER TABLE public.document_verifications DISABLE TRIGGER USER;
ALTER TABLE public.document_signatures DISABLE TRIGGER USER;
ALTER TABLE public.prescription_orders DISABLE TRIGGER USER;
ALTER TABLE public.medical_documents DISABLE TRIGGER USER;
ALTER TABLE public.document_templates DISABLE TRIGGER USER;
ALTER TABLE public.doctor_profiles DISABLE TRIGGER USER;

DROP TABLE IF EXISTS public.document_verifications, public.document_events, public.document_signatures,
  public.prescription_orders, public.medical_documents, public.document_templates,
  public.doctor_patient_assignments, public.doctor_profiles, public.document_counters,
  public.document_verify_attempts, public.clinical_retention_policy,
  public.document_signature_policy, public.signature_providers CASCADE;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'clinical\_document\_%' OR p.proname LIKE 'doctor\_%' OR p.proname LIKE 'template\_%'
           OR p.proname LIKE 'signature\_%' OR p.proname LIKE 'document\_verify\_%'
           OR p.proname IN ('member_list_documents', '_doc_event', '_require_doctor', '_template_author',
                            '_template_validate', '_next_document_number', '_snapshot_identity',
                            '_validate_prescription', '_sha256_hex', '_member_ref', '_json_only_keys', '_clean_text',
                            '_assurance_rank', '_today_sast', '_rx_required_keys', '_template_allowed_keys',
                            '_deny_mutation', '_deny_delete', '_medical_documents_guard', '_prescription_orders_guard',
                            '_prescription_status_sync', '_document_templates_guard', '_document_signatures_guard',
                            '_current_doctor_id'))
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', f.sig);
  END LOOP;
END
$$;

-- The storage bucket is left in place: deleting stored documents is a separate, deliberate retention decision.

COMMIT;
