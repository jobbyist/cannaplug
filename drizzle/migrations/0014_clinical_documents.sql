-- Clinical Document & Prescription System.
--
-- Two separate document types with separate rules: MEDICAL_LETTER and PRESCRIPTION_ORDER.
-- A template only carries wording/layout. Every member-specific document is generated first, frozen and
-- hashed, shown to the practitioner exactly as rendered, and only then approved and signed by that
-- practitioner. Nothing here copies a signature from a template onto a document, and nothing here
-- chooses a clinical value: dosage, strength, quantity, route, frequency, duration, repeats, indication
-- and every clinical sentence come from the practitioner and are only checked for presence and format.
--
-- Access model (see CANNAPLUG.md "Clinical documents" for the reasoning):
--   * No client role can INSERT/UPDATE/DELETE any clinical table. Writes happen only through the
--     SECURITY DEFINER functions below, executable by service_role only, each taking an explicit actor.
--   * authenticated can SELECT only non-clinical metadata columns, and only the rows RLS allows
--     (member: own issued documents; doctor: documents assigned to them; admin: metadata for oversight).
--     Clinical content (source_data_snapshot, rendered_content, storage path, verification token,
--     hashes' inputs) is read only through audited functions.
--   * Budtenders and managers have no clinical access at all. Admins configure the system and can
--     revoke, but cannot create, approve or sign anything and cannot read clinical content.
--   * Triggers make the data append-only/immutable even for a buggy or compromised service-role caller.
--
-- Signature assurance is a recorded human decision (signature_providers + document_signature_policy):
-- nothing is treated as an advanced or qualified signature unless an administrator has recorded that
-- compliance confirmed it, and prescriptions can never be signed with a SIMPLE method.

-- ---------------------------------------------------------------------------
-- 1. Practitioners
-- ---------------------------------------------------------------------------

CREATE TABLE public.doctor_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  first_name text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
  last_name text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
  title text NOT NULL DEFAULT 'Dr' CHECK (length(btrim(title)) BETWEEN 1 AND 30),
  hpcsa_number text CHECK (hpcsa_number IS NULL OR hpcsa_number ~ '^[A-Za-z0-9/ -]{3,30}$'),
  practice_number text CHECK (practice_number IS NULL OR practice_number ~ '^[A-Za-z0-9/ -]{3,30}$'),
  qualification text CHECK (length(qualification) <= 200),
  speciality text CHECK (length(speciality) <= 200),
  practice_name text CHECK (length(practice_name) <= 200),
  practice_address text CHECK (length(practice_address) <= 400),
  practice_phone text CHECK (practice_phone IS NULL OR practice_phone ~ '^[0-9+() -]{7,40}$'),
  practice_email text CHECK (practice_email IS NULL OR practice_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- A registration number is only text until someone checks it against the HPCSA register.
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending', 'verified', 'suspended', 'revoked')),
  verified_at timestamptz,
  verified_by uuid REFERENCES auth.users(id),
  verification_note text CHECK (length(verification_note) <= 500),
  -- Separate, explicit authorisation to issue prescriptions (an administrator records it after checking
  -- the practitioner's scope; it is never implied by "verified").
  prescribing_authorised boolean NOT NULL DEFAULT false,
  signature_status text NOT NULL DEFAULT 'not_enrolled'
    CHECK (signature_status IN ('not_enrolled', 'enrolled', 'suspended')),
  signature_provider text,
  signature_provider_ref text CHECK (length(signature_provider_ref) <= 200),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT doctor_verified_chk CHECK (
    verification_status <> 'verified'
    OR (hpcsa_number IS NOT NULL AND verified_at IS NOT NULL AND verified_by IS NOT NULL)),
  CONSTRAINT doctor_prescribing_chk CHECK (NOT prescribing_authorised OR verification_status = 'verified')
);

CREATE TABLE public.doctor_patient_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES public.doctor_profiles(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  assigned_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by uuid REFERENCES auth.users(id)
);
CREATE UNIQUE INDEX doctor_patient_active_uniq
  ON public.doctor_patient_assignments (doctor_id, member_id) WHERE status = 'active';
CREATE INDEX doctor_patient_member_idx ON public.doctor_patient_assignments (member_id);

-- ---------------------------------------------------------------------------
-- 2. Signature policy (recorded compliance decisions) and providers
-- ---------------------------------------------------------------------------

CREATE TABLE public.signature_providers (
  provider text PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  display_name text NOT NULL,
  -- What an administrator has recorded the provider's method as. NOT a claim made by the code.
  assurance_level text NOT NULL DEFAULT 'SIMPLE' CHECK (assurance_level IN ('SIMPLE', 'ADVANCED', 'QUALIFIED')),
  signature_method text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz,
  confirmation_note text CHECK (length(confirmation_note) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signature_provider_enabled_chk CHECK (NOT enabled OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE TABLE public.document_signature_policy (
  document_type text PRIMARY KEY CHECK (document_type IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER')),
  required_assurance text NOT NULL CHECK (required_assurance IN ('SIMPLE', 'ADVANCED', 'QUALIFIED')),
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz,
  confirmation_note text CHECK (length(confirmation_note) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A prescription is never signed with a plain (simple) electronic signature.
  CONSTRAINT prescription_never_simple_chk CHECK (document_type <> 'PRESCRIPTION_ORDER' OR required_assurance <> 'SIMPLE')
);

-- Safe defaults: nothing is usable until an administrator records the compliance decision.
INSERT INTO public.document_signature_policy (document_type, required_assurance) VALUES
  ('MEDICAL_LETTER', 'SIMPLE'),
  ('PRESCRIPTION_ORDER', 'ADVANCED');
INSERT INTO public.signature_providers (provider, display_name, signature_method, assurance_level) VALUES
  ('internal_simple', 'Internal practitioner attestation', 'SIMPLE_INTERNAL_ATTESTATION', 'SIMPLE'),
  ('external_generic', 'External signature provider (generic REST)', 'EXTERNAL_PROVIDER', 'SIMPLE');

-- ---------------------------------------------------------------------------
-- 3. Templates (versioned; wording and layout only, never a signature)
-- ---------------------------------------------------------------------------

CREATE TABLE public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL CHECK (document_type IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'ARCHIVED', 'REVOKED')),
  template_content text NOT NULL,
  template_schema jsonb NOT NULL,
  change_note text CHECK (length(change_note) <= 500),
  review_note text CHECK (length(review_note) <= 500),
  created_by uuid REFERENCES auth.users(id),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_type, name, version),
  CONSTRAINT template_active_chk CHECK (
    status <> 'ACTIVE' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND effective_from IS NOT NULL)),
  CONSTRAINT template_window_chk CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until > effective_from)
);
CREATE UNIQUE INDEX document_templates_one_active_idx
  ON public.document_templates (document_type, name) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- 4. Documents
-- ---------------------------------------------------------------------------

CREATE TABLE public.document_counters (
  document_type text NOT NULL,
  year integer NOT NULL,
  last_value integer NOT NULL DEFAULT 0,
  PRIMARY KEY (document_type, year)
);

CREATE TABLE public.medical_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id text NOT NULL UNIQUE,                      -- human reference, e.g. CP-MED-2026-000184
  document_type text NOT NULL CHECK (document_type IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER')),
  member_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES public.doctor_profiles(id) ON DELETE RESTRICT,
  template_id uuid NOT NULL REFERENCES public.document_templates(id) ON DELETE RESTRICT,
  template_version integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
    ('DRAFT', 'PENDING_DOCTOR_REVIEW', 'APPROVED', 'SIGNING', 'SIGNED', 'ISSUED', 'EXPIRED', 'REVOKED', 'VOID')),
  document_version integer NOT NULL DEFAULT 1 CHECK (document_version >= 1),
  supersedes_document_id uuid REFERENCES public.medical_documents(id),
  source_data_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,   -- clinical: never exposed publicly
  rendered_content text,                                      -- the exact frozen text that is hashed
  pdf_storage_path text,
  document_hash text CHECK (document_hash IS NULL OR document_hash ~ '^[0-9a-f]{64}$'),
  verification_token text NOT NULL UNIQUE CHECK (verification_token ~ '^[A-Za-z0-9_-]{43}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  review_started_at timestamptz,
  review_note text CHECK (length(review_note) <= 1000),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  issued_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id),
  revocation_reason text CHECK (length(revocation_reason) <= 500),
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Integrity at rest: the stored hash is always the hash of the stored text, whoever wrote it.
  CONSTRAINT medical_documents_hash_matches_chk CHECK (
    (rendered_content IS NULL AND document_hash IS NULL)
    OR (rendered_content IS NOT NULL AND document_hash = encode(sha256(convert_to(rendered_content, 'utf8')), 'hex'))),
  CONSTRAINT medical_documents_frozen_chk CHECK (
    status IN ('DRAFT', 'VOID') OR (rendered_content IS NOT NULL AND document_hash IS NOT NULL)),
  CONSTRAINT medical_documents_approved_chk CHECK (
    status IN ('DRAFT', 'PENDING_DOCTOR_REVIEW', 'VOID') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT medical_documents_issued_chk CHECK (
    status NOT IN ('ISSUED', 'EXPIRED') OR (issued_at IS NOT NULL AND pdf_storage_path IS NOT NULL)),
  CONSTRAINT medical_documents_revoked_chk CHECK (
    status <> 'REVOKED' OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL)),
  CONSTRAINT medical_documents_voided_chk CHECK (status <> 'VOID' OR voided_at IS NOT NULL),
  CONSTRAINT medical_documents_prescription_expiry_chk CHECK (
    document_type <> 'PRESCRIPTION_ORDER' OR status = 'DRAFT' OR status = 'VOID' OR expires_at IS NOT NULL)
);
CREATE INDEX medical_documents_member_idx ON public.medical_documents (member_id, created_at DESC);
CREATE INDEX medical_documents_doctor_status_idx ON public.medical_documents (doctor_id, status, created_at DESC);
CREATE INDEX medical_documents_expiry_idx ON public.medical_documents (expires_at) WHERE status = 'ISSUED';

CREATE TABLE public.prescription_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL UNIQUE REFERENCES public.medical_documents(id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  prescriber_id uuid NOT NULL REFERENCES public.doctor_profiles(id) ON DELETE RESTRICT,
  issue_date date,
  -- Every clinical value below is entered by the practitioner. There are deliberately NO defaults.
  medicine_name text CHECK (length(medicine_name) <= 200),
  generic_name text CHECK (length(generic_name) <= 200),
  dosage_form text CHECK (length(dosage_form) <= 100),
  strength text CHECK (length(strength) <= 100),
  quantity_numeric numeric CHECK (quantity_numeric IS NULL OR (quantity_numeric > 0 AND quantity_numeric < 100000)),
  quantity_words text CHECK (length(quantity_words) <= 200),
  directions text CHECK (length(directions) <= 1000),
  route text CHECK (length(route) <= 100),
  frequency text CHECK (length(frequency) <= 200),
  duration text CHECK (length(duration) <= 200),
  repeats integer CHECK (repeats IS NULL OR repeats BETWEEN 0 AND 99),
  indication text CHECK (length(indication) <= 500),
  special_instructions text CHECK (length(special_instructions) <= 1000),
  status text NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.document_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.medical_documents(id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES public.doctor_profiles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  signature_provider text NOT NULL REFERENCES public.signature_providers(provider),
  signature_method text NOT NULL,
  assurance_level text NOT NULL CHECK (assurance_level IN ('SIMPLE', 'ADVANCED', 'QUALIFIED')),
  provider_request_id text CHECK (length(provider_request_id) <= 200),
  signature_reference text,
  signed_at timestamptz,
  certificate_subject text,
  certificate_issuer text,
  certificate_serial text,
  document_hash_before_signature text NOT NULL CHECK (document_hash_before_signature ~ '^[0-9a-f]{64}$'),
  document_hash_after_signature text CHECK (document_hash_after_signature IS NULL OR document_hash_after_signature ~ '^[0-9a-f]{64}$'),
  signature_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text CHECK (length(failure_code) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_signatures_completed_chk CHECK (
    status <> 'COMPLETED' OR (signature_reference IS NOT NULL AND signed_at IS NOT NULL AND document_hash_after_signature IS NOT NULL))
);
CREATE UNIQUE INDEX document_signatures_one_pending_idx ON public.document_signatures (document_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX document_signatures_one_completed_idx ON public.document_signatures (document_id) WHERE status = 'COMPLETED';

-- Append-only audit trail. Free text never goes in metadata (no health information in the log).
CREATE TABLE public.document_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.medical_documents(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES auth.users(id),
  actor_role text NOT NULL CHECK (actor_role IN ('member', 'doctor', 'admin', 'system')),
  event_type text NOT NULL CHECK (event_type IN (
    'CREATED', 'TEMPLATE_SELECTED', 'DATA_CAPTURED', 'DRAFT_UPDATED', 'DOCTOR_REVIEW_STARTED',
    'DOCTOR_APPROVED', 'DOCTOR_REJECTED', 'PDF_GENERATED', 'SIGNATURE_REQUESTED', 'SIGNATURE_COMPLETED',
    'SIGNATURE_FAILED', 'ISSUED', 'DOWNLOADED', 'VIEWED', 'VERIFIED', 'REVOKED', 'EXPIRED', 'VOIDED',
    'NOTIFICATION_SENT', 'NOTIFICATION_FAILED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text CHECK (length(ip_address) <= 64),
  user_agent text CHECK (length(user_agent) <= 256),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_events_doc_idx ON public.document_events (document_id, created_at);
CREATE INDEX document_events_created_idx ON public.document_events (created_at DESC);

CREATE TABLE public.document_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.medical_documents(id) ON DELETE RESTRICT,
  verification_token text NOT NULL,
  document_hash text,
  verification_status text NOT NULL CHECK (verification_status IN
    ('VALID', 'REVOKED', 'EXPIRED', 'VOID', 'NOT_ISSUED', 'INTEGRITY_FAILURE')),
  requester_hash text,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_verifications_doc_idx ON public.document_verifications (document_id, verified_at DESC);

-- Fixed-window counters for the public verification endpoint (hashed requester, never a raw IP).
CREATE TABLE public.document_verify_attempts (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Proposed retention classes. Values are PROPOSALS awaiting counsel/practitioner confirmation; nothing in
-- the system deletes clinical records, so retention is enforced by there being no delete path at all.
CREATE TABLE public.clinical_retention_policy (
  record_class text PRIMARY KEY,
  proposed_min_years integer NOT NULL CHECK (proposed_min_years >= 0),
  basis text NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'CONFIRMED')),
  confirmed_by text,
  confirmed_at timestamptz,
  purge_enabled boolean NOT NULL DEFAULT false CHECK (NOT purge_enabled OR status = 'CONFIRMED')
);
INSERT INTO public.clinical_retention_policy (record_class, proposed_min_years, basis) VALUES
  ('medical_letter', 6, 'Proposed: HPCSA-style minimum for patient records; confirm with the practitioner and counsel.'),
  ('prescription_record', 6, 'Proposed: confirm against the Medicines and Related Substances Act regulations and the pharmacist; may be longer.'),
  ('signature_record', 6, 'Follows the document it signs.'),
  ('audit_event', 6, 'Follows the document it relates to; contains no health information.'),
  ('verification_event', 2, 'Operational record of public verifications; contains no health information.'),
  ('revoked_document', 6, 'Revocation never shortens retention; follows the source document class.');

-- ---------------------------------------------------------------------------
-- 5. Immutability and state-machine triggers
-- ---------------------------------------------------------------------------

CREATE FUNCTION public._sha256_hex(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT encode(sha256(convert_to(p, 'utf8')), 'hex') $$;

CREATE FUNCTION public._deny_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record: % on % is not permitted', TG_OP, TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION public._deny_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'retention: records in % are never deleted (revoke or void instead)', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER document_events_no_update BEFORE UPDATE ON public.document_events
  FOR EACH ROW EXECUTE FUNCTION public._deny_mutation();
CREATE TRIGGER document_events_no_delete BEFORE DELETE ON public.document_events
  FOR EACH ROW EXECUTE FUNCTION public._deny_mutation();
CREATE TRIGGER document_events_no_truncate BEFORE TRUNCATE ON public.document_events
  FOR EACH STATEMENT EXECUTE FUNCTION public._deny_mutation();
CREATE TRIGGER document_verifications_no_update BEFORE UPDATE ON public.document_verifications
  FOR EACH ROW EXECUTE FUNCTION public._deny_mutation();
CREATE TRIGGER document_verifications_no_delete BEFORE DELETE ON public.document_verifications
  FOR EACH ROW EXECUTE FUNCTION public._deny_mutation();
CREATE TRIGGER document_verifications_no_truncate BEFORE TRUNCATE ON public.document_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION public._deny_mutation();

CREATE TRIGGER medical_documents_no_delete BEFORE DELETE ON public.medical_documents
  FOR EACH ROW EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER medical_documents_no_truncate BEFORE TRUNCATE ON public.medical_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER prescription_orders_no_delete BEFORE DELETE ON public.prescription_orders
  FOR EACH ROW EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER prescription_orders_no_truncate BEFORE TRUNCATE ON public.prescription_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER document_signatures_no_delete BEFORE DELETE ON public.document_signatures
  FOR EACH ROW EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER document_signatures_no_truncate BEFORE TRUNCATE ON public.document_signatures
  FOR EACH STATEMENT EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER doctor_profiles_no_delete BEFORE DELETE ON public.doctor_profiles
  FOR EACH ROW EXECUTE FUNCTION public._deny_delete();
CREATE TRIGGER document_templates_no_delete BEFORE DELETE ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public._deny_delete();

-- Document state machine + frozen columns.
CREATE FUNCTION public._medical_documents_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_ok boolean;
  v_mutable text[] := ARRAY['status', 'updated_at', 'approved_at', 'approved_by', 'pdf_storage_path',
                            'issued_at', 'revoked_at', 'revoked_by', 'revocation_reason', 'voided_at',
                            'review_note', 'review_started_at'];
  v_once text;
BEGIN
  IF OLD.status = 'DRAFT' THEN
    -- A draft's content is editable; its identity is not.
    IF NEW.document_id <> OLD.document_id OR NEW.document_type <> OLD.document_type
       OR NEW.member_id <> OLD.member_id OR NEW.doctor_id <> OLD.doctor_id
       OR NEW.verification_token <> OLD.verification_token OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'immutable_record: document identity cannot change' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Request-changes is the one move that unfreezes content (before approval only).
    IF OLD.status = 'PENDING_DOCTOR_REVIEW' AND NEW.status = 'DRAFT' THEN
      v_mutable := v_mutable || ARRAY['rendered_content', 'document_hash', 'source_data_snapshot', 'expires_at'];
    END IF;
    IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
      RAISE EXCEPTION 'immutable_record: a frozen document cannot be modified (create a new version)'
        USING ERRCODE = '42501';
    END IF;
    -- Write-once columns.
    FOREACH v_once IN ARRAY ARRAY['approved_at', 'approved_by', 'pdf_storage_path', 'issued_at',
                                  'revoked_at', 'revoked_by', 'revocation_reason', 'voided_at'] LOOP
      IF (to_jsonb(OLD) -> v_once) <> 'null'::jsonb
         AND (to_jsonb(NEW) -> v_once) IS DISTINCT FROM (to_jsonb(OLD) -> v_once) THEN
        RAISE EXCEPTION 'immutable_record: % is write-once', v_once USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := CASE OLD.status
      WHEN 'DRAFT' THEN NEW.status IN ('PENDING_DOCTOR_REVIEW', 'VOID')
      WHEN 'PENDING_DOCTOR_REVIEW' THEN NEW.status IN ('APPROVED', 'DRAFT', 'VOID')
      WHEN 'APPROVED' THEN NEW.status IN ('SIGNING', 'VOID')
      WHEN 'SIGNING' THEN NEW.status IN ('SIGNED', 'APPROVED', 'VOID')
      WHEN 'SIGNED' THEN NEW.status IN ('ISSUED', 'REVOKED')
      WHEN 'ISSUED' THEN NEW.status IN ('EXPIRED', 'REVOKED')
      WHEN 'EXPIRED' THEN NEW.status IN ('REVOKED')
      ELSE false END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'invalid_transition: % -> % is not allowed', OLD.status, NEW.status;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER medical_documents_guard BEFORE UPDATE ON public.medical_documents
  FOR EACH ROW EXECUTE FUNCTION public._medical_documents_guard();

-- Prescription content freezes with its document; status mirrors the document.
CREATE FUNCTION public._prescription_orders_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT d.status INTO v_status FROM public.medical_documents d WHERE d.id = OLD.document_id;
  IF v_status <> 'DRAFT'
     AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'issue_date'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'issue_date']) THEN
    RAISE EXCEPTION 'immutable_record: prescription content is frozen once the document leaves DRAFT'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.document_id <> OLD.document_id OR NEW.member_id <> OLD.member_id OR NEW.prescriber_id <> OLD.prescriber_id THEN
    RAISE EXCEPTION 'immutable_record: prescription identity cannot change' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER prescription_orders_guard BEFORE UPDATE ON public.prescription_orders
  FOR EACH ROW EXECUTE FUNCTION public._prescription_orders_guard();

CREATE FUNCTION public._prescription_status_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.prescription_orders SET status = NEW.status WHERE document_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER medical_documents_rx_sync AFTER UPDATE ON public.medical_documents
  FOR EACH ROW EXECUTE FUNCTION public._prescription_status_sync();

-- Templates: content is frozen once a version leaves DRAFT; a change is a new version.
CREATE FUNCTION public._document_templates_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF OLD.status <> 'DRAFT' AND (
       NEW.template_content IS DISTINCT FROM OLD.template_content
       OR NEW.template_schema IS DISTINCT FROM OLD.template_schema
       OR NEW.document_type <> OLD.document_type OR NEW.name <> OLD.name OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'immutable_record: a non-draft template cannot be edited; create a new version'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'DRAFT' AND (NEW.document_type <> OLD.document_type OR NEW.name <> OLD.name
                                OR NEW.version <> OLD.version) THEN
    RAISE EXCEPTION 'immutable_record: template identity cannot change' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := CASE OLD.status
      WHEN 'DRAFT' THEN NEW.status IN ('PENDING_APPROVAL')
      WHEN 'PENDING_APPROVAL' THEN NEW.status IN ('ACTIVE', 'DRAFT', 'REVOKED')
      WHEN 'ACTIVE' THEN NEW.status IN ('ARCHIVED', 'REVOKED')
      ELSE false END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'invalid_transition: template % -> % is not allowed', OLD.status, NEW.status;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_templates_guard BEFORE UPDATE ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public._document_templates_guard();

-- Signatures: a completed signature never changes; pending ones only resolve forward.
CREATE FUNCTION public._document_signatures_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'immutable_record: a resolved signature record cannot be modified' USING ERRCODE = '42501';
  END IF;
  IF NEW.document_id <> OLD.document_id OR NEW.doctor_id <> OLD.doctor_id
     OR NEW.signature_provider <> OLD.signature_provider
     OR NEW.document_hash_before_signature <> OLD.document_hash_before_signature
     OR NEW.assurance_level <> OLD.assurance_level THEN
    RAISE EXCEPTION 'immutable_record: signature identity cannot change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_signatures_guard BEFORE UPDATE ON public.document_signatures
  FOR EACH ROW EXECUTE FUNCTION public._document_signatures_guard();

-- ---------------------------------------------------------------------------
-- 6. Row Level Security and grants
--    Writes: none for client roles. Reads: metadata columns only (clinical content is read through the
--    audited functions in section 8).
-- ---------------------------------------------------------------------------

ALTER TABLE public.doctor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_patient_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_signature_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.medical_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescription_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_verify_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinical_retention_policy ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.doctor_profiles, public.doctor_patient_assignments, public.signature_providers,
  public.document_signature_policy, public.document_templates, public.document_counters,
  public.medical_documents, public.prescription_orders, public.document_signatures,
  public.document_events, public.document_verifications, public.document_verify_attempts,
  public.clinical_retention_policy FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.document_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- service_role may read everything and write only where no function is the sole path; the functions
-- (owned by the migration role) do the real writing. Append-only tables are SELECT-only here.
GRANT SELECT ON public.doctor_profiles, public.doctor_patient_assignments, public.signature_providers,
  public.document_signature_policy, public.document_templates, public.document_counters,
  public.medical_documents, public.prescription_orders, public.document_signatures,
  public.document_events, public.document_verifications, public.document_verify_attempts,
  public.clinical_retention_policy TO service_role;

-- Practitioner and assignment metadata (no registration numbers beyond what the owner needs).
GRANT SELECT ON public.doctor_profiles TO authenticated;
GRANT SELECT ON public.doctor_patient_assignments TO authenticated;
GRANT SELECT ON public.signature_providers, public.document_signature_policy,
  public.clinical_retention_policy TO authenticated;
GRANT SELECT (id, document_type, name, version, status, change_note, created_by, approved_by, approved_at,
              effective_from, effective_until, created_at, updated_at)
  ON public.document_templates TO authenticated;
GRANT SELECT (id, document_id, document_type, member_id, doctor_id, template_id, template_version, status,
              document_version, supersedes_document_id, created_by, approved_at, issued_at, expires_at,
              revoked_at, voided_at, created_at, updated_at)
  ON public.medical_documents TO authenticated;
GRANT SELECT ON public.prescription_orders TO authenticated;
GRANT SELECT (id, document_id, doctor_id, status, signature_provider, signature_method, assurance_level,
              signed_at, certificate_subject, certificate_issuer, certificate_serial,
              document_hash_before_signature, document_hash_after_signature, created_at)
  ON public.document_signatures TO authenticated;
GRANT SELECT (id, document_id, actor_user_id, actor_role, event_type, metadata, created_at)
  ON public.document_events TO authenticated;
GRANT SELECT (id, document_id, verification_status, verified_at, created_at)
  ON public.document_verifications TO authenticated;

CREATE FUNCTION public._current_doctor_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT dp.id FROM public.doctor_profiles dp WHERE dp.user_id = (SELECT auth.uid()) $$;
REVOKE EXECUTE ON FUNCTION public._current_doctor_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._current_doctor_id() TO authenticated;

-- doctor_profiles: a practitioner sees their own row; admin sees all (registration review).
CREATE POLICY "doctor own profile" ON public.doctor_profiles FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "admin reads doctors" ON public.doctor_profiles FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));

CREATE POLICY "doctor own assignments" ON public.doctor_patient_assignments FOR SELECT TO authenticated
  USING (doctor_id = public._current_doctor_id());
CREATE POLICY "member own assignments" ON public.doctor_patient_assignments FOR SELECT TO authenticated
  USING (member_id = (SELECT auth.uid()));
CREATE POLICY "admin reads assignments" ON public.doctor_patient_assignments FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));

CREATE POLICY "admin reads providers" ON public.signature_providers FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));
CREATE POLICY "admin reads signature policy" ON public.document_signature_policy FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));
CREATE POLICY "admin reads retention" ON public.clinical_retention_policy FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));

-- Templates hold wording, not health information: practitioners and admins read them.
CREATE POLICY "doctor or admin reads templates" ON public.document_templates FOR SELECT TO authenticated
  USING (public._current_doctor_id() IS NOT NULL OR public.has_at_least_role('admin'::public.app_role));

CREATE POLICY "member reads own issued documents" ON public.medical_documents FOR SELECT TO authenticated
  USING (member_id = (SELECT auth.uid()) AND status IN ('ISSUED', 'EXPIRED', 'REVOKED'));
CREATE POLICY "doctor reads assigned documents" ON public.medical_documents FOR SELECT TO authenticated
  USING (doctor_id = public._current_doctor_id());
CREATE POLICY "admin reads document metadata" ON public.medical_documents FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));

CREATE POLICY "doctor reads own prescriptions" ON public.prescription_orders FOR SELECT TO authenticated
  USING (prescriber_id = public._current_doctor_id());
CREATE POLICY "member reads own issued prescriptions" ON public.prescription_orders FOR SELECT TO authenticated
  USING (member_id = (SELECT auth.uid()) AND status IN ('ISSUED', 'EXPIRED', 'REVOKED'));

-- Child tables inherit visibility from the document (the sub-select runs under the caller's RLS).
CREATE POLICY "signatures follow document" ON public.document_signatures FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.medical_documents d WHERE d.id = document_signatures.document_id));
CREATE POLICY "events follow document (doctor/admin)" ON public.document_events FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role)
         OR EXISTS (SELECT 1 FROM public.medical_documents d
                    WHERE d.id = document_events.document_id AND d.doctor_id = public._current_doctor_id()));
CREATE POLICY "admin reads verifications" ON public.document_verifications FOR SELECT TO authenticated
  USING (public.has_at_least_role('admin'::public.app_role));

-- ---------------------------------------------------------------------------
-- 7. Storage: a private bucket, no storage policies => service role only. Files are PDFs, 10 MB max.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('clinical-documents', 'clinical-documents', false, 10485760, ARRAY['application/pdf'])
    ON CONFLICT (id) DO UPDATE
      SET public = false, file_size_limit = 10485760, allowed_mime_types = ARRAY['application/pdf'];
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 8. Helpers
-- ---------------------------------------------------------------------------

CREATE FUNCTION public._assurance_rank(p text) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT CASE p WHEN 'SIMPLE' THEN 1 WHEN 'ADVANCED' THEN 2 WHEN 'QUALIFIED' THEN 3 ELSE 0 END $$;

CREATE FUNCTION public._today_sast() RETURNS date
LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date $$;

CREATE FUNCTION public._doc_event(
  p_doc uuid, p_actor uuid, p_role text, p_type text,
  p_meta jsonb DEFAULT '{}'::jsonb, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  INSERT INTO public.document_events (document_id, actor_user_id, actor_role, event_type, metadata, ip_address, user_agent)
  VALUES (p_doc, p_actor, p_role, p_type, COALESCE(p_meta, '{}'::jsonb), left(p_ip, 64), left(p_ua, 256));
$$;

-- The practitioner behind an action: verified, active, and (for prescriptions) explicitly authorised.
-- Being an administrator, manager or budtender never satisfies this.
CREATE FUNCTION public._require_doctor(p_actor uuid, p_prescribing boolean DEFAULT false)
RETURNS public.doctor_profiles
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_doc public.doctor_profiles;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_doc FROM public.doctor_profiles WHERE user_id = p_actor;
  IF NOT FOUND OR NOT v_doc.is_active OR v_doc.verification_status <> 'verified' THEN
    RAISE EXCEPTION 'forbidden: a verified, active practitioner is required' USING ERRCODE = '42501';
  END IF;
  IF p_prescribing AND NOT v_doc.prescribing_authorised THEN
    RAISE EXCEPTION 'forbidden: this practitioner is not authorised to issue prescriptions' USING ERRCODE = '42501';
  END IF;
  RETURN v_doc;
END;
$$;

CREATE FUNCTION public._template_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT ARRAY[
  'doctor.title', 'doctor.full_name', 'doctor.hpcsa_number', 'doctor.practice_number', 'doctor.qualification',
  'doctor.speciality', 'doctor.practice_name', 'doctor.practice_address', 'doctor.practice_phone',
  'doctor.practice_email',
  'member.full_name', 'member.member_id', 'member.date_of_birth',
  'document.issue_date', 'document.expiry_date', 'document.document_id',
  'prescription.medicine_name', 'prescription.generic_name', 'prescription.dosage_form',
  'prescription.strength', 'prescription.quantity_numeric', 'prescription.quantity_words',
  'prescription.directions', 'prescription.route', 'prescription.frequency', 'prescription.duration',
  'prescription.repeats', 'prescription.indication', 'prescription.special_instructions',
  'clinical.statement', 'clinical.indication_summary', 'clinical.treatment_summary'
] $$;

-- Prescription fields the practitioner must always supply (generic name and special instructions are optional).
CREATE FUNCTION public._rx_required_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT ARRAY['medicine_name', 'dosage_form', 'strength', 'quantity_numeric', 'quantity_words',
                   'directions', 'route', 'frequency', 'duration', 'repeats', 'indication'] $$;

-- Structural checks only: plain text with whitelisted {{placeholders}}; no markup, no scripting surface.
CREATE FUNCTION public._template_validate(p_type text, p_content text, p_schema jsonb)
RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v_key text;
  v_found text[] := ARRAY[]::text[];
  v_stripped text;
  v_entry jsonb;
  v_schema_keys text[] := ARRAY[]::text[];
  v_k text;
BEGIN
  IF p_content IS NULL OR length(p_content) NOT BETWEEN 20 AND 20000 THEN
    RAISE EXCEPTION 'template_invalid: content must be 20-20000 characters';
  END IF;
  IF p_content ~ '[<>]' OR p_content ~ '[\x00-\x08\x0B\x0C\x0E-\x1F]' THEN
    RAISE EXCEPTION 'template_invalid: markup and control characters are not allowed in templates';
  END IF;
  FOR v_key IN SELECT m[1] FROM regexp_matches(p_content, '\{\{([^{}]*)\}\}', 'g') AS m LOOP
    v_key := btrim(v_key);
    IF NOT (v_key = ANY (public._template_allowed_keys())) THEN
      RAISE EXCEPTION 'template_invalid: unknown placeholder {{%}}', v_key;
    END IF;
    v_found := v_found || v_key;
  END LOOP;
  v_stripped := regexp_replace(p_content, '\{\{[^{}]*\}\}', '', 'g');
  IF v_stripped ~ '\{\{|\}\}' OR v_stripped ~ '[{}]' THEN
    RAISE EXCEPTION 'template_invalid: unbalanced braces';
  END IF;
  IF p_schema IS NULL OR jsonb_typeof(p_schema) <> 'object' OR jsonb_typeof(p_schema -> 'placeholders') <> 'array' THEN
    RAISE EXCEPTION 'template_invalid: template_schema must be {"placeholders": [...]}';
  END IF;
  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_schema -> 'placeholders') LOOP
    v_k := v_entry ->> 'key';
    IF v_k IS NULL OR NOT (v_k = ANY (public._template_allowed_keys())) THEN
      RAISE EXCEPTION 'template_invalid: schema names an unknown placeholder';
    END IF;
    v_schema_keys := v_schema_keys || v_k;
    -- Clinical placeholders are always required (only generic name / special instructions may be optional).
    IF (v_k LIKE 'clinical.%' OR (v_k LIKE 'prescription.%' AND substr(v_k, 14) = ANY (public._rx_required_keys())))
       AND COALESCE((v_entry ->> 'required')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'template_invalid: clinical placeholder % must be marked required', v_k;
    END IF;
  END LOOP;
  FOREACH v_k IN ARRAY v_found LOOP
    IF NOT (v_k = ANY (v_schema_keys)) THEN
      RAISE EXCEPTION 'template_invalid: placeholder {{%}} is missing from template_schema', v_k;
    END IF;
  END LOOP;
  IF p_type = 'MEDICAL_LETTER' THEN
    IF EXISTS (SELECT 1 FROM unnest(v_found) k WHERE k LIKE 'prescription.%') THEN
      RAISE EXCEPTION 'template_invalid: a medical letter template cannot contain prescription fields';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(v_found) k WHERE k LIKE 'clinical.%') THEN
      RAISE EXCEPTION 'template_invalid: a medical letter template needs at least one practitioner-entered {{clinical.*}} field';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM unnest(v_found) k WHERE k LIKE 'clinical.%') THEN
      RAISE EXCEPTION 'template_invalid: a prescription template cannot contain clinical.* letter fields';
    END IF;
    FOREACH v_k IN ARRAY public._rx_required_keys() LOOP
      IF NOT (('prescription.' || v_k) = ANY (v_found)) THEN
        RAISE EXCEPTION 'template_invalid: a prescription template must contain {{prescription.%}}', v_k;
      END IF;
    END LOOP;
    IF NOT ('document.expiry_date' = ANY (v_found)) THEN
      RAISE EXCEPTION 'template_invalid: a prescription template must contain {{document.expiry_date}}';
    END IF;
  END IF;
  IF NOT ('doctor.full_name' = ANY (v_found)) OR NOT ('doctor.hpcsa_number' = ANY (v_found))
     OR NOT ('document.document_id' = ANY (v_found)) OR NOT ('member.full_name' = ANY (v_found)) THEN
    RAISE EXCEPTION 'template_invalid: templates must show the practitioner name, registration number, document id and member name';
  END IF;
END;
$$;

CREATE FUNCTION public._next_document_number(p_type text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_year integer := extract(year FROM (now() AT TIME ZONE 'Africa/Johannesburg'))::integer;
  v_n integer;
BEGIN
  INSERT INTO public.document_counters (document_type, year, last_value) VALUES (p_type, v_year, 1)
  ON CONFLICT (document_type, year) DO UPDATE SET last_value = public.document_counters.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN 'CP-' || CASE p_type WHEN 'MEDICAL_LETTER' THEN 'MED' ELSE 'RX' END || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
END;
$$;

CREATE FUNCTION public._member_ref(p_user uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT 'CP-M-' || upper(substr(replace(p_user::text, '-', ''), 1, 8)) $$;

CREATE FUNCTION public._json_only_keys(p jsonb, p_allowed text[], p_label text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  k text;
BEGIN
  IF p IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'invalid_input: % must be an object', p_label;
  END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (k = ANY (p_allowed)) THEN
      RAISE EXCEPTION 'invalid_input: unknown % field %', p_label, k;
    END IF;
  END LOOP;
END;
$$;

-- Trims a JSON string value; empty becomes NULL; control characters and markup are rejected.
CREATE FUNCTION public._clean_text(p jsonb, p_key text, p_max integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  v text;
BEGIN
  IF p IS NULL OR NOT (p ? p_key) OR jsonb_typeof(p -> p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p -> p_key) <> 'string' THEN
    RAISE EXCEPTION 'invalid_input: % must be text', p_key;
  END IF;
  v := NULLIF(btrim(p ->> p_key), '');
  IF v IS NULL THEN RETURN NULL; END IF;
  IF length(v) > p_max THEN
    RAISE EXCEPTION 'invalid_input: % is too long (max % characters)', p_key, p_max;
  END IF;
  IF v ~ '[<>]' OR v ~ '[\x00-\x08\x0B\x0C\x0E-\x1F]' THEN
    RAISE EXCEPTION 'invalid_input: % contains characters that are not allowed', p_key;
  END IF;
  RETURN v;
END;
$$;

CREATE FUNCTION public._snapshot_identity(p_doctor uuid, p_member uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  pr public.profiles;
BEGIN
  SELECT * INTO d FROM public.doctor_profiles WHERE id = p_doctor;
  SELECT * INTO pr FROM public.profiles WHERE id = p_member;
  IF pr.full_name IS NULL OR btrim(pr.full_name) = '' OR pr.date_of_birth IS NULL THEN
    RAISE EXCEPTION 'member_profile_incomplete: the member needs a full name and verified date of birth';
  END IF;
  RETURN jsonb_build_object(
    'doctor', jsonb_build_object(
      'title', d.title, 'full_name', btrim(d.first_name || ' ' || d.last_name),
      'hpcsa_number', d.hpcsa_number, 'practice_number', d.practice_number,
      'qualification', d.qualification, 'speciality', d.speciality, 'practice_name', d.practice_name,
      'practice_address', d.practice_address, 'practice_phone', d.practice_phone,
      'practice_email', d.practice_email),
    'member', jsonb_build_object(
      'full_name', btrim(pr.full_name), 'member_id', public._member_ref(p_member),
      'date_of_birth', to_char(pr.date_of_birth, 'YYYY-MM-DD')));
END;
$$;

-- Presence/format validation only. The software never proposes or corrects a clinical value.
CREATE FUNCTION public._validate_prescription(p_doc uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  rx public.prescription_orders;
  d public.medical_documents;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO d FROM public.medical_documents WHERE id = p_doc;
  SELECT * INTO rx FROM public.prescription_orders WHERE document_id = p_doc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prescription_incomplete: no prescription data has been entered';
  END IF;
  IF rx.medicine_name IS NULL THEN v_missing := array_append(v_missing, 'medicine_name'); END IF;
  IF rx.dosage_form IS NULL THEN v_missing := array_append(v_missing, 'dosage_form'); END IF;
  IF rx.strength IS NULL THEN v_missing := array_append(v_missing, 'strength'); END IF;
  IF rx.quantity_numeric IS NULL THEN v_missing := array_append(v_missing, 'quantity_numeric'); END IF;
  IF rx.quantity_words IS NULL THEN v_missing := array_append(v_missing, 'quantity_words'); END IF;
  IF rx.directions IS NULL THEN v_missing := array_append(v_missing, 'directions'); END IF;
  IF rx.route IS NULL THEN v_missing := array_append(v_missing, 'route'); END IF;
  IF rx.frequency IS NULL THEN v_missing := array_append(v_missing, 'frequency'); END IF;
  IF rx.duration IS NULL THEN v_missing := array_append(v_missing, 'duration'); END IF;
  IF rx.repeats IS NULL THEN v_missing := array_append(v_missing, 'repeats'); END IF;
  IF rx.indication IS NULL THEN v_missing := array_append(v_missing, 'indication'); END IF;
  IF d.expires_at IS NULL THEN v_missing := array_append(v_missing, 'expiry_date'); END IF;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'prescription_incomplete: the practitioner must enter %', array_to_string(v_missing, ', ');
  END IF;
  IF d.expires_at <= now() THEN
    RAISE EXCEPTION 'prescription_invalid: the expiry date must be in the future';
  END IF;
  IF rx.prescriber_id <> d.doctor_id OR rx.member_id <> d.member_id THEN
    RAISE EXCEPTION 'prescription_invalid: prescription does not match its document';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Administration (admin only; none of these can touch clinical content or sign)
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.doctor_admin_upsert(p_actor uuid, p_user_id uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  PERFORM public._json_only_keys(p_data, ARRAY['first_name', 'last_name', 'title', 'hpcsa_number',
    'practice_number', 'qualification', 'speciality', 'practice_name', 'practice_address',
    'practice_phone', 'practice_email', 'is_active'], 'doctor');
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'user_not_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.doctor_profiles WHERE user_id = p_user_id) THEN
    INSERT INTO public.doctor_profiles (user_id, first_name, last_name, title)
    VALUES (p_user_id, COALESCE(public._clean_text(p_data, 'first_name', 100), 'Unnamed'),
            COALESCE(public._clean_text(p_data, 'last_name', 100), 'Practitioner'),
            COALESCE(public._clean_text(p_data, 'title', 30), 'Dr'));
  END IF;
  -- Registration fields change => verification no longer describes what is stored: back to pending.
  UPDATE public.doctor_profiles dp SET
    first_name = COALESCE(public._clean_text(p_data, 'first_name', 100), dp.first_name),
    last_name = COALESCE(public._clean_text(p_data, 'last_name', 100), dp.last_name),
    title = COALESCE(public._clean_text(p_data, 'title', 30), dp.title),
    hpcsa_number = CASE WHEN p_data ? 'hpcsa_number' THEN public._clean_text(p_data, 'hpcsa_number', 30) ELSE dp.hpcsa_number END,
    practice_number = CASE WHEN p_data ? 'practice_number' THEN public._clean_text(p_data, 'practice_number', 30) ELSE dp.practice_number END,
    qualification = CASE WHEN p_data ? 'qualification' THEN public._clean_text(p_data, 'qualification', 200) ELSE dp.qualification END,
    speciality = CASE WHEN p_data ? 'speciality' THEN public._clean_text(p_data, 'speciality', 200) ELSE dp.speciality END,
    practice_name = CASE WHEN p_data ? 'practice_name' THEN public._clean_text(p_data, 'practice_name', 200) ELSE dp.practice_name END,
    practice_address = CASE WHEN p_data ? 'practice_address' THEN public._clean_text(p_data, 'practice_address', 400) ELSE dp.practice_address END,
    practice_phone = CASE WHEN p_data ? 'practice_phone' THEN public._clean_text(p_data, 'practice_phone', 40) ELSE dp.practice_phone END,
    practice_email = CASE WHEN p_data ? 'practice_email' THEN public._clean_text(p_data, 'practice_email', 200) ELSE dp.practice_email END,
    is_active = COALESCE((p_data ->> 'is_active')::boolean, dp.is_active),
    verification_status = CASE WHEN (p_data ? 'hpcsa_number' OR p_data ? 'first_name' OR p_data ? 'last_name')
                                 AND dp.verification_status = 'verified' THEN 'pending' ELSE dp.verification_status END,
    prescribing_authorised = CASE WHEN (p_data ? 'hpcsa_number' OR p_data ? 'first_name' OR p_data ? 'last_name')
                                 AND dp.verification_status = 'verified' THEN false ELSE dp.prescribing_authorised END,
    verified_at = CASE WHEN (p_data ? 'hpcsa_number' OR p_data ? 'first_name' OR p_data ? 'last_name')
                                 AND dp.verification_status = 'verified' THEN NULL ELSE dp.verified_at END,
    verified_by = CASE WHEN (p_data ? 'hpcsa_number' OR p_data ? 'first_name' OR p_data ? 'last_name')
                                 AND dp.verification_status = 'verified' THEN NULL ELSE dp.verified_by END,
    updated_at = now()
  WHERE dp.user_id = p_user_id
  RETURNING dp.id INTO v_id;
  PERFORM public._audit(p_actor, 'doctor_profile_saved', 'doctor_profile', v_id,
    jsonb_build_object('user_id', p_user_id));
  RETURN jsonb_build_object('doctor_id', v_id);
END;
$$;

-- Verification is a human check against the HPCSA register. Nobody verifies themselves.
CREATE FUNCTION public.doctor_admin_set_status(
  p_actor uuid, p_doctor_id uuid, p_status text, p_note text,
  p_prescribing_authorised boolean DEFAULT false, p_signature_status text DEFAULT NULL,
  p_signature_provider text DEFAULT NULL, p_signature_provider_ref text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  SELECT * INTO d FROM public.doctor_profiles WHERE id = p_doctor_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'doctor_not_found'; END IF;
  IF p_status NOT IN ('pending', 'verified', 'suspended', 'revoked') THEN
    RAISE EXCEPTION 'invalid_input: unknown verification status';
  END IF;
  IF p_status = 'verified' THEN
    IF d.user_id = p_actor THEN
      RAISE EXCEPTION 'self_verification_forbidden: another administrator must verify your registration'
        USING ERRCODE = '42501';
    END IF;
    IF d.hpcsa_number IS NULL THEN
      RAISE EXCEPTION 'invalid_input: enter the HPCSA registration number before verifying';
    END IF;
  END IF;
  IF p_prescribing_authorised AND p_status <> 'verified' THEN
    RAISE EXCEPTION 'invalid_input: only a verified practitioner can be authorised to prescribe';
  END IF;
  IF p_prescribing_authorised AND d.user_id = p_actor THEN
    RAISE EXCEPTION 'self_verification_forbidden: another administrator must authorise your prescribing'
      USING ERRCODE = '42501';
  END IF;
  IF p_signature_status IS NOT NULL AND p_signature_status NOT IN ('not_enrolled', 'enrolled', 'suspended') THEN
    RAISE EXCEPTION 'invalid_input: unknown signature status';
  END IF;
  IF p_signature_provider IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.signature_providers WHERE provider = p_signature_provider) THEN
    RAISE EXCEPTION 'invalid_input: unknown signature provider';
  END IF;
  UPDATE public.doctor_profiles SET
    verification_status = p_status,
    verified_at = CASE WHEN p_status = 'verified' THEN now() ELSE NULL END,
    verified_by = CASE WHEN p_status = 'verified' THEN p_actor ELSE NULL END,
    verification_note = left(v_note, 500),
    prescribing_authorised = CASE WHEN p_status = 'verified' THEN p_prescribing_authorised ELSE false END,
    signature_status = COALESCE(p_signature_status, signature_status),
    signature_provider = COALESCE(p_signature_provider, signature_provider),
    signature_provider_ref = COALESCE(left(p_signature_provider_ref, 200), signature_provider_ref),
    updated_at = now()
  WHERE id = p_doctor_id;
  PERFORM public._audit(p_actor, 'doctor_status_set', 'doctor_profile', p_doctor_id,
    jsonb_build_object('status', p_status, 'prescribing', p_prescribing_authorised,
                       'signature_status', p_signature_status));
  RETURN jsonb_build_object('doctor_id', p_doctor_id, 'status', p_status);
END;
$$;

-- The practitioner may keep their own contact details current; registration data is admin-only.
CREATE FUNCTION public.doctor_update_own_profile(p_actor uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
BEGIN
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden: practitioner profile required' USING ERRCODE = '42501'; END IF;
  PERFORM public._json_only_keys(p_data, ARRAY['practice_name', 'practice_address', 'practice_phone', 'practice_email'], 'profile');
  UPDATE public.doctor_profiles SET
    practice_name = CASE WHEN p_data ? 'practice_name' THEN public._clean_text(p_data, 'practice_name', 200) ELSE practice_name END,
    practice_address = CASE WHEN p_data ? 'practice_address' THEN public._clean_text(p_data, 'practice_address', 400) ELSE practice_address END,
    practice_phone = CASE WHEN p_data ? 'practice_phone' THEN public._clean_text(p_data, 'practice_phone', 40) ELSE practice_phone END,
    practice_email = CASE WHEN p_data ? 'practice_email' THEN public._clean_text(p_data, 'practice_email', 200) ELSE practice_email END,
    updated_at = now()
  WHERE id = d.id;
  RETURN jsonb_build_object('doctor_id', d.id);
END;
$$;

CREATE FUNCTION public.doctor_assign_patient(p_actor uuid, p_doctor_id uuid, p_member_id uuid, p_assign boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  SELECT * INTO d FROM public.doctor_profiles WHERE id = p_doctor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'doctor_not_found'; END IF;
  IF d.user_id = p_member_id THEN RAISE EXCEPTION 'invalid_input: a practitioner cannot be their own patient'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_member_id) THEN RAISE EXCEPTION 'member_not_found'; END IF;
  IF p_assign THEN
    INSERT INTO public.doctor_patient_assignments (doctor_id, member_id, assigned_by)
    VALUES (p_doctor_id, p_member_id, p_actor) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE public.doctor_patient_assignments SET status = 'ended', ended_at = now(), ended_by = p_actor
    WHERE doctor_id = p_doctor_id AND member_id = p_member_id AND status = 'active';
  END IF;
  PERFORM public._audit(p_actor, CASE WHEN p_assign THEN 'doctor_patient_assigned' ELSE 'doctor_patient_unassigned' END,
    'doctor_profile', p_doctor_id, jsonb_build_object('member_id', p_member_id));
  RETURN jsonb_build_object('doctor_id', p_doctor_id, 'member_id', p_member_id, 'assigned', p_assign);
END;
$$;

CREATE FUNCTION public.signature_provider_set(
  p_actor uuid, p_provider text, p_assurance text, p_enabled boolean, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  IF p_assurance NOT IN ('SIMPLE', 'ADVANCED', 'QUALIFIED') THEN RAISE EXCEPTION 'invalid_input: assurance level'; END IF;
  IF (p_enabled OR p_assurance <> 'SIMPLE') AND length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'confirmation_required: record who confirmed this (practitioner / compliance / counsel) and the basis';
  END IF;
  UPDATE public.signature_providers SET
    assurance_level = p_assurance, enabled = p_enabled,
    confirmed_by = CASE WHEN p_enabled OR p_assurance <> 'SIMPLE' THEN p_actor ELSE NULL END,
    confirmed_at = CASE WHEN p_enabled OR p_assurance <> 'SIMPLE' THEN now() ELSE NULL END,
    confirmation_note = left(btrim(p_note), 1000), updated_at = now()
  WHERE provider = p_provider;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_input: unknown provider'; END IF;
  PERFORM public._audit(p_actor, 'signature_provider_set', 'signature_provider', NULL,
    jsonb_build_object('provider', p_provider, 'assurance', p_assurance, 'enabled', p_enabled));
  RETURN jsonb_build_object('provider', p_provider, 'assurance', p_assurance, 'enabled', p_enabled);
END;
$$;

CREATE FUNCTION public.signature_policy_set(p_actor uuid, p_type text, p_required text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  IF p_required NOT IN ('SIMPLE', 'ADVANCED', 'QUALIFIED') THEN RAISE EXCEPTION 'invalid_input: assurance level'; END IF;
  IF p_type = 'PRESCRIPTION_ORDER' AND p_required = 'SIMPLE' THEN
    RAISE EXCEPTION 'invalid_input: prescriptions cannot be signed with a simple electronic signature';
  END IF;
  IF length(btrim(COALESCE(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'confirmation_required: record who confirmed this requirement and the legal basis';
  END IF;
  UPDATE public.document_signature_policy SET required_assurance = p_required, confirmed_by = p_actor,
    confirmed_at = now(), confirmation_note = left(btrim(p_note), 1000), updated_at = now()
  WHERE document_type = p_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_input: unknown document type'; END IF;
  PERFORM public._audit(p_actor, 'signature_policy_set', 'document_signature_policy', NULL,
    jsonb_build_object('document_type', p_type, 'required', p_required));
  RETURN jsonb_build_object('document_type', p_type, 'required_assurance', p_required);
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Templates
-- ---------------------------------------------------------------------------

-- Authors: a verified practitioner or an administrator may DRAFT wording. Neither can activate it alone.
CREATE FUNCTION public._template_author(p_actor uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.doctor_profiles WHERE user_id = p_actor AND is_active AND verification_status = 'verified') THEN
    RETURN 'doctor';
  END IF;
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  RETURN 'admin';
END;
$$;

CREATE FUNCTION public.template_create(
  p_actor uuid, p_type text, p_name text, p_content text, p_schema jsonb, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_version integer;
BEGIN
  PERFORM public._template_author(p_actor);
  IF p_type NOT IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER') THEN RAISE EXCEPTION 'invalid_input: document type'; END IF;
  PERFORM public._template_validate(p_type, p_content, p_schema);
  SELECT COALESCE(max(version), 0) + 1 INTO v_version FROM public.document_templates
  WHERE document_type = p_type AND name = btrim(p_name);
  INSERT INTO public.document_templates (document_type, name, version, template_content, template_schema, change_note, created_by)
  VALUES (p_type, btrim(p_name), v_version, p_content, p_schema, left(p_note, 500), p_actor)
  RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'template_created', 'document_template', v_id, jsonb_build_object('version', v_version));
  RETURN jsonb_build_object('template_id', v_id, 'version', v_version);
END;
$$;

CREATE FUNCTION public.template_update_draft(p_actor uuid, p_template_id uuid, p_content text, p_schema jsonb, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  t public.document_templates;
BEGIN
  PERFORM public._template_author(p_actor);
  SELECT * INTO t FROM public.document_templates WHERE id = p_template_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  IF t.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'template_locked: only a draft can be edited — create a new version instead';
  END IF;
  PERFORM public._template_validate(t.document_type, p_content, p_schema);
  UPDATE public.document_templates SET template_content = p_content, template_schema = p_schema,
    change_note = left(p_note, 500), review_note = NULL WHERE id = p_template_id;
  RETURN jsonb_build_object('template_id', p_template_id);
END;
$$;

-- A change to anything that is not a draft is a NEW VERSION (copy, DRAFT, +1). History is never mutated.
CREATE FUNCTION public.template_new_version(p_actor uuid, p_template_id uuid, p_content text, p_schema jsonb, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  t public.document_templates;
  v_id uuid;
  v_version integer;
BEGIN
  PERFORM public._template_author(p_actor);
  SELECT * INTO t FROM public.document_templates WHERE id = p_template_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('template:' || t.document_type || ':' || t.name));
  IF EXISTS (SELECT 1 FROM public.document_templates
             WHERE document_type = t.document_type AND name = t.name AND status IN ('DRAFT', 'PENDING_APPROVAL')) THEN
    RAISE EXCEPTION 'template_locked: finish or reject the existing draft of this template first';
  END IF;
  PERFORM public._template_validate(t.document_type, COALESCE(p_content, t.template_content), COALESCE(p_schema, t.template_schema));
  SELECT max(version) + 1 INTO v_version FROM public.document_templates
  WHERE document_type = t.document_type AND name = t.name;
  INSERT INTO public.document_templates (document_type, name, version, template_content, template_schema, change_note, created_by)
  VALUES (t.document_type, t.name, v_version, COALESCE(p_content, t.template_content),
          COALESCE(p_schema, t.template_schema), left(p_note, 500), p_actor)
  RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'template_version_created', 'document_template', v_id,
    jsonb_build_object('version', v_version, 'from', p_template_id));
  RETURN jsonb_build_object('template_id', v_id, 'version', v_version);
END;
$$;

CREATE FUNCTION public.template_submit(p_actor uuid, p_template_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  t public.document_templates;
BEGIN
  PERFORM public._template_author(p_actor);
  SELECT * INTO t FROM public.document_templates WHERE id = p_template_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  PERFORM public._template_validate(t.document_type, t.template_content, t.template_schema);
  UPDATE public.document_templates SET status = 'PENDING_APPROVAL' WHERE id = p_template_id;
  PERFORM public._audit(p_actor, 'template_submitted', 'document_template', p_template_id, '{}'::jsonb);
  RETURN jsonb_build_object('template_id', p_template_id, 'status', 'PENDING_APPROVAL');
END;
$$;

-- Only a verified practitioner approves wording (and, for prescriptions, one authorised to prescribe).
-- Seed text still carrying the placeholder marker can never be activated.
CREATE FUNCTION public.template_decide(
  p_actor uuid, p_template_id uuid, p_approve boolean, p_note text,
  p_effective_until timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  t public.document_templates;
BEGIN
  SELECT * INTO t FROM public.document_templates WHERE id = p_template_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  PERFORM public._require_doctor(p_actor, t.document_type = 'PRESCRIPTION_ORDER');
  IF t.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'invalid_transition: the template is not awaiting approval';
  END IF;
  IF p_approve THEN
    IF t.template_content LIKE '%[[SEED-PLACEHOLDER]]%' THEN
      RAISE EXCEPTION 'template_placeholder: replace the placeholder wording with practitioner-approved text first';
    END IF;
    IF p_effective_until IS NOT NULL AND p_effective_until <= now() THEN
      RAISE EXCEPTION 'invalid_input: effective-until must be in the future';
    END IF;
    PERFORM public._template_validate(t.document_type, t.template_content, t.template_schema);
    UPDATE public.document_templates SET status = 'ARCHIVED'
    WHERE document_type = t.document_type AND name = t.name AND status = 'ACTIVE';
    UPDATE public.document_templates SET status = 'ACTIVE', approved_by = p_actor, approved_at = now(),
      effective_from = now(), effective_until = p_effective_until, review_note = left(p_note, 500)
    WHERE id = p_template_id;
  ELSE
    IF length(btrim(COALESCE(p_note, ''))) < 3 THEN RAISE EXCEPTION 'invalid_input: say what needs to change'; END IF;
    UPDATE public.document_templates SET status = 'DRAFT', review_note = left(btrim(p_note), 500) WHERE id = p_template_id;
  END IF;
  PERFORM public._audit(p_actor, CASE WHEN p_approve THEN 'template_approved' ELSE 'template_rejected' END,
    'document_template', p_template_id, jsonb_build_object('version', t.version));
  RETURN jsonb_build_object('template_id', p_template_id, 'status', CASE WHEN p_approve THEN 'ACTIVE' ELSE 'DRAFT' END);
END;
$$;

-- Retire or revoke a template (admin or practitioner). Documents already issued from it are unaffected.
CREATE FUNCTION public.template_retire(p_actor uuid, p_template_id uuid, p_revoke boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  t public.document_templates;
BEGIN
  PERFORM public._template_author(p_actor);
  SELECT * INTO t FROM public.document_templates WHERE id = p_template_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'template_not_found'; END IF;
  IF t.status NOT IN ('ACTIVE', 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'invalid_transition: only an active or pending template can be retired';
  END IF;
  IF t.status = 'PENDING_APPROVAL' AND NOT p_revoke THEN
    RAISE EXCEPTION 'invalid_transition: a pending template can only be revoked';
  END IF;
  UPDATE public.document_templates SET status = CASE WHEN p_revoke THEN 'REVOKED' ELSE 'ARCHIVED' END,
    review_note = left(p_note, 500) WHERE id = p_template_id;
  PERFORM public._audit(p_actor, CASE WHEN p_revoke THEN 'template_revoked' ELSE 'template_archived' END,
    'document_template', p_template_id, jsonb_build_object('version', t.version));
  RETURN jsonb_build_object('template_id', p_template_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. Document lifecycle (practitioner)
-- ---------------------------------------------------------------------------

-- Only the practitioner creates documents. Administrators, managers and budtenders cannot create a
-- letter or a prescription, so no clinical sentence or value can originate from CannaPlug staff.
CREATE FUNCTION public.clinical_document_create(
  p_actor uuid, p_type text, p_member_id uuid, p_template_id uuid, p_clinical jsonb, p_prescription jsonb,
  p_expires_at timestamptz, p_token text, p_idempotency_key text,
  p_supersedes uuid DEFAULT NULL, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  t public.document_templates;
  v_cached jsonb;
  v_status text;
  v_doc uuid;
  v_number text;
  v_version integer := 1;
  v_old public.medical_documents;
  v_snapshot jsonb;
  v_result jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_type NOT IN ('MEDICAL_LETTER', 'PRESCRIPTION_ORDER') THEN RAISE EXCEPTION 'invalid_input: document type'; END IF;
  d := public._require_doctor(p_actor, p_type = 'PRESCRIPTION_ORDER');
  v_cached := public._idem_begin('doc_create', p_actor, p_idempotency_key,
    jsonb_build_object('t', p_type, 'm', p_member_id, 'tpl', p_template_id, 'c', p_clinical, 'p', p_prescription,
                       'e', p_expires_at, 's', p_supersedes));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'invalid_input: verification token must be 43 URL-safe characters from a secure random source';
  END IF;
  IF d.user_id = p_member_id THEN RAISE EXCEPTION 'forbidden: a practitioner cannot issue a document to themselves' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.doctor_patient_assignments
                 WHERE doctor_id = d.id AND member_id = p_member_id AND status = 'active') THEN
    RAISE EXCEPTION 'forbidden: this member is not assigned to you' USING ERRCODE = '42501';
  END IF;
  SELECT cv.status INTO v_status FROM public.customer_verification cv WHERE cv.user_id = p_member_id;
  IF v_status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'member_not_verified: the member''s identity must be verified first';
  END IF;

  SELECT * INTO t FROM public.document_templates WHERE id = p_template_id;
  IF NOT FOUND OR t.document_type <> p_type OR t.status <> 'ACTIVE'
     OR t.effective_from > now() OR (t.effective_until IS NOT NULL AND t.effective_until <= now()) THEN
    RAISE EXCEPTION 'template_unavailable: choose an active, approved template for this document type';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.document_signature_policy
                 WHERE document_type = p_type AND confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'signature_policy_unconfirmed: the required signature level for this document type has not been confirmed by compliance';
  END IF;

  PERFORM public._json_only_keys(p_clinical, ARRAY['statement', 'indication_summary', 'treatment_summary'], 'clinical');
  PERFORM public._json_only_keys(p_prescription, ARRAY['medicine_name', 'generic_name', 'dosage_form', 'strength',
    'quantity_numeric', 'quantity_words', 'directions', 'route', 'frequency', 'duration', 'repeats',
    'indication', 'special_instructions'], 'prescription');
  IF p_type = 'MEDICAL_LETTER' AND p_prescription IS NOT NULL AND p_prescription <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_input: a medical letter cannot carry prescription data';
  END IF;
  IF p_type = 'PRESCRIPTION_ORDER' AND p_clinical IS NOT NULL AND p_clinical <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_input: a prescription cannot carry letter fields';
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_input: the expiry date must be in the future';
  END IF;

  IF p_supersedes IS NOT NULL THEN
    SELECT * INTO v_old FROM public.medical_documents WHERE id = p_supersedes;
    IF NOT FOUND OR v_old.doctor_id <> d.id OR v_old.member_id <> p_member_id OR v_old.document_type <> p_type THEN
      RAISE EXCEPTION 'forbidden: you can only supersede your own document for the same member' USING ERRCODE = '42501';
    END IF;
    v_version := v_old.document_version + 1;
  END IF;

  v_number := public._next_document_number(p_type);
  v_snapshot := public._snapshot_identity(d.id, p_member_id)
    || jsonb_build_object('clinical', COALESCE(
         (SELECT jsonb_object_agg(k, public._clean_text(p_clinical, k, 4000))
          FROM unnest(ARRAY['statement', 'indication_summary', 'treatment_summary']) k
          WHERE public._clean_text(p_clinical, k, 4000) IS NOT NULL), '{}'::jsonb));

  INSERT INTO public.medical_documents (document_id, document_type, member_id, doctor_id, template_id, template_version,
      document_version, supersedes_document_id, source_data_snapshot, verification_token, created_by, expires_at)
  VALUES (v_number, p_type, p_member_id, d.id, t.id, t.version, v_version, p_supersedes, v_snapshot, p_token, p_actor, p_expires_at)
  RETURNING id INTO v_doc;

  IF p_type = 'PRESCRIPTION_ORDER' THEN
    INSERT INTO public.prescription_orders (document_id, member_id, prescriber_id, medicine_name, generic_name, dosage_form,
        strength, quantity_numeric, quantity_words, directions, route, frequency, duration, repeats, indication,
        special_instructions)
    VALUES (v_doc, p_member_id, d.id,
        public._clean_text(p_prescription, 'medicine_name', 200), public._clean_text(p_prescription, 'generic_name', 200),
        public._clean_text(p_prescription, 'dosage_form', 100), public._clean_text(p_prescription, 'strength', 100),
        CASE WHEN p_prescription ? 'quantity_numeric' AND jsonb_typeof(p_prescription -> 'quantity_numeric') = 'number'
             THEN (p_prescription ->> 'quantity_numeric')::numeric END,
        public._clean_text(p_prescription, 'quantity_words', 200), public._clean_text(p_prescription, 'directions', 1000),
        public._clean_text(p_prescription, 'route', 100), public._clean_text(p_prescription, 'frequency', 200),
        public._clean_text(p_prescription, 'duration', 200),
        CASE WHEN p_prescription ? 'repeats' AND jsonb_typeof(p_prescription -> 'repeats') = 'number'
             THEN (p_prescription ->> 'repeats')::integer END,
        public._clean_text(p_prescription, 'indication', 500), public._clean_text(p_prescription, 'special_instructions', 1000));
  END IF;

  PERFORM public._doc_event(v_doc, p_actor, 'doctor', 'CREATED',
    jsonb_build_object('document_type', p_type, 'version', v_version), p_ip, p_ua);
  PERFORM public._doc_event(v_doc, p_actor, 'doctor', 'TEMPLATE_SELECTED',
    jsonb_build_object('template_id', t.id, 'template_version', t.version), p_ip, p_ua);
  PERFORM public._doc_event(v_doc, p_actor, 'doctor', 'DATA_CAPTURED', '{}'::jsonb, p_ip, p_ua);

  v_result := jsonb_build_object('id', v_doc, 'document_id', v_number, 'status', 'DRAFT');
  RETURN public._idem_finish('doc_create', p_actor, p_idempotency_key, v_result);
END;
$$;

-- Edit a DRAFT only (the practitioner's own). Present keys are replaced; null clears.
CREATE FUNCTION public.clinical_document_update_draft(
  p_actor uuid, p_doc uuid, p_clinical jsonb, p_prescription jsonb, p_expires_at timestamptz,
  p_set_expiry boolean DEFAULT false, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  doc public.medical_documents;
  v_clin jsonb;
  k text;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  d := public._require_doctor(p_actor, doc.document_type = 'PRESCRIPTION_ORDER');
  IF doc.doctor_id <> d.id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  IF doc.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'document_locked: only a draft can be edited — void it and create a new version';
  END IF;
  PERFORM public._json_only_keys(p_clinical, ARRAY['statement', 'indication_summary', 'treatment_summary'], 'clinical');
  PERFORM public._json_only_keys(p_prescription, ARRAY['medicine_name', 'generic_name', 'dosage_form', 'strength',
    'quantity_numeric', 'quantity_words', 'directions', 'route', 'frequency', 'duration', 'repeats',
    'indication', 'special_instructions'], 'prescription');
  IF p_set_expiry AND p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_input: the expiry date must be in the future';
  END IF;

  IF doc.document_type = 'MEDICAL_LETTER' AND p_clinical IS NOT NULL THEN
    v_clin := COALESCE(doc.source_data_snapshot -> 'clinical', '{}'::jsonb);
    FOR k IN SELECT jsonb_object_keys(p_clinical) LOOP
      v_clin := v_clin - k;
      IF public._clean_text(p_clinical, k, 4000) IS NOT NULL THEN
        v_clin := v_clin || jsonb_build_object(k, public._clean_text(p_clinical, k, 4000));
      END IF;
    END LOOP;
    UPDATE public.medical_documents SET source_data_snapshot = source_data_snapshot || jsonb_build_object('clinical', v_clin)
    WHERE id = p_doc;
  ELSIF doc.document_type = 'PRESCRIPTION_ORDER' AND p_clinical IS NOT NULL AND p_clinical <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_input: a prescription cannot carry letter fields';
  END IF;

  IF doc.document_type = 'PRESCRIPTION_ORDER' AND p_prescription IS NOT NULL THEN
    UPDATE public.prescription_orders rx SET
      medicine_name = CASE WHEN p_prescription ? 'medicine_name' THEN public._clean_text(p_prescription, 'medicine_name', 200) ELSE rx.medicine_name END,
      generic_name = CASE WHEN p_prescription ? 'generic_name' THEN public._clean_text(p_prescription, 'generic_name', 200) ELSE rx.generic_name END,
      dosage_form = CASE WHEN p_prescription ? 'dosage_form' THEN public._clean_text(p_prescription, 'dosage_form', 100) ELSE rx.dosage_form END,
      strength = CASE WHEN p_prescription ? 'strength' THEN public._clean_text(p_prescription, 'strength', 100) ELSE rx.strength END,
      quantity_numeric = CASE WHEN p_prescription ? 'quantity_numeric'
        THEN CASE WHEN jsonb_typeof(p_prescription -> 'quantity_numeric') = 'number' THEN (p_prescription ->> 'quantity_numeric')::numeric END
        ELSE rx.quantity_numeric END,
      quantity_words = CASE WHEN p_prescription ? 'quantity_words' THEN public._clean_text(p_prescription, 'quantity_words', 200) ELSE rx.quantity_words END,
      directions = CASE WHEN p_prescription ? 'directions' THEN public._clean_text(p_prescription, 'directions', 1000) ELSE rx.directions END,
      route = CASE WHEN p_prescription ? 'route' THEN public._clean_text(p_prescription, 'route', 100) ELSE rx.route END,
      frequency = CASE WHEN p_prescription ? 'frequency' THEN public._clean_text(p_prescription, 'frequency', 200) ELSE rx.frequency END,
      duration = CASE WHEN p_prescription ? 'duration' THEN public._clean_text(p_prescription, 'duration', 200) ELSE rx.duration END,
      repeats = CASE WHEN p_prescription ? 'repeats'
        THEN CASE WHEN jsonb_typeof(p_prescription -> 'repeats') = 'number' THEN (p_prescription ->> 'repeats')::integer END
        ELSE rx.repeats END,
      indication = CASE WHEN p_prescription ? 'indication' THEN public._clean_text(p_prescription, 'indication', 500) ELSE rx.indication END,
      special_instructions = CASE WHEN p_prescription ? 'special_instructions' THEN public._clean_text(p_prescription, 'special_instructions', 1000) ELSE rx.special_instructions END
    WHERE rx.document_id = p_doc;
  END IF;
  IF p_set_expiry THEN
    UPDATE public.medical_documents SET expires_at = p_expires_at WHERE id = p_doc;
  END IF;
  PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'DRAFT_UPDATED', '{}'::jsonb, p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'DRAFT');
END;
$$;

-- Step 1 of freezing: re-read identity, validate, hand the server everything it needs to render.
-- The snapshot hash returned here must be echoed back to clinical_document_submit, so the text the
-- practitioner reviews is provably rendered from exactly this data.
CREATE FUNCTION public.clinical_document_prepare(p_actor uuid, p_doc uuid, p_issue_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  doc public.medical_documents;
  t public.document_templates;
  v_snapshot jsonb;
  rx jsonb;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  d := public._require_doctor(p_actor, doc.document_type = 'PRESCRIPTION_ORDER');
  IF doc.doctor_id <> d.id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  IF doc.status <> 'DRAFT' THEN RAISE EXCEPTION 'document_locked: only a draft can be prepared'; END IF;
  IF p_issue_date IS NULL OR abs(p_issue_date - public._today_sast()) > 1 THEN
    RAISE EXCEPTION 'invalid_input: the document date must be today';
  END IF;
  SELECT * INTO t FROM public.document_templates WHERE id = doc.template_id;
  IF t.status <> 'ACTIVE' OR (t.effective_until IS NOT NULL AND t.effective_until <= now()) THEN
    RAISE EXCEPTION 'template_unavailable: the template this draft was started from is no longer active — create a new draft';
  END IF;
  IF doc.expires_at IS NOT NULL AND doc.expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_input: the expiry date must be in the future';
  END IF;
  IF doc.document_type = 'PRESCRIPTION_ORDER' THEN
    PERFORM public._validate_prescription(p_doc);
    SELECT to_jsonb(r) - ARRAY['id', 'document_id', 'member_id', 'prescriber_id', 'status', 'created_at', 'updated_at']
    INTO rx FROM public.prescription_orders r WHERE r.document_id = p_doc;
    rx := rx || jsonb_build_object('issue_date', p_issue_date);
  END IF;
  v_snapshot := public._snapshot_identity(doc.doctor_id, doc.member_id)
    || jsonb_build_object('clinical', COALESCE(doc.source_data_snapshot -> 'clinical', '{}'::jsonb),
                          'document', jsonb_build_object(
                            'document_id', doc.document_id,
                            'issue_date', to_char(p_issue_date, 'YYYY-MM-DD'),
                            'expiry_date', CASE WHEN doc.expires_at IS NULL THEN NULL
                              ELSE to_char(doc.expires_at AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD') END));
  IF rx IS NOT NULL THEN v_snapshot := v_snapshot || jsonb_build_object('prescription', rx); END IF;
  UPDATE public.medical_documents SET source_data_snapshot = v_snapshot WHERE id = p_doc;
  IF doc.document_type = 'PRESCRIPTION_ORDER' THEN
    UPDATE public.prescription_orders SET issue_date = p_issue_date WHERE document_id = p_doc;
  END IF;
  RETURN jsonb_build_object(
    'id', p_doc, 'document_type', doc.document_type, 'snapshot', v_snapshot,
    'snapshot_hash', public._sha256_hex(v_snapshot::text),
    'template', jsonb_build_object('id', t.id, 'version', t.version, 'content', t.template_content, 'schema', t.template_schema));
END;
$$;

-- Step 2: freeze. The database computes the hash of the exact text; the practitioner then reviews it.
CREATE FUNCTION public.clinical_document_submit(
  p_actor uuid, p_doc uuid, p_rendered text, p_snapshot_hash text, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  doc public.medical_documents;
  v_hash text;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  d := public._require_doctor(p_actor, doc.document_type = 'PRESCRIPTION_ORDER');
  IF doc.doctor_id <> d.id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  IF doc.status <> 'DRAFT' THEN RAISE EXCEPTION 'document_locked: only a draft can be submitted for review'; END IF;
  IF public._sha256_hex(doc.source_data_snapshot::text) IS DISTINCT FROM p_snapshot_hash THEN
    RAISE EXCEPTION 'snapshot_changed: the data changed after it was prepared — prepare the document again';
  END IF;
  IF p_rendered IS NULL OR length(p_rendered) NOT BETWEEN 50 AND 200000 OR p_rendered ~ '[\x00-\x08\x0B\x0C\x0E-\x1F]' THEN
    RAISE EXCEPTION 'invalid_input: rendered content is missing or malformed';
  END IF;
  IF doc.document_type = 'PRESCRIPTION_ORDER' THEN PERFORM public._validate_prescription(p_doc); END IF;
  v_hash := public._sha256_hex(p_rendered);
  UPDATE public.medical_documents SET rendered_content = p_rendered, document_hash = v_hash,
    status = 'PENDING_DOCTOR_REVIEW' WHERE id = p_doc;
  PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'PDF_GENERATED',
    jsonb_build_object('stage', 'rendered_for_review', 'hash', v_hash), p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'PENDING_DOCTOR_REVIEW', 'document_hash', v_hash);
END;
$$;

-- Everything the practitioner needs to review (or re-open) a document. Audited.
CREATE FUNCTION public.clinical_document_doctor_view(p_actor uuid, p_doc uuid, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
  v_first boolean;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
  IF NOT FOUND OR doc.doctor_id <> d.id THEN
    RAISE EXCEPTION 'document_not_found';   -- other practitioners learn nothing about it
  END IF;
  v_first := doc.status = 'PENDING_DOCTOR_REVIEW' AND doc.review_started_at IS NULL;
  IF v_first THEN
    UPDATE public.medical_documents SET review_started_at = now() WHERE id = p_doc;
    PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'DOCTOR_REVIEW_STARTED', '{}'::jsonb, p_ip, p_ua);
  END IF;
  PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'VIEWED', '{}'::jsonb, p_ip, p_ua);
  RETURN jsonb_build_object(
    'id', doc.id, 'document_id', doc.document_id, 'document_type', doc.document_type, 'status', doc.status,
    'member_id', doc.member_id, 'template_id', doc.template_id, 'template_version', doc.template_version,
    'document_version', doc.document_version, 'document_hash', doc.document_hash,
    'rendered_content', doc.rendered_content, 'snapshot', doc.source_data_snapshot,
    'expires_at', doc.expires_at, 'issued_at', doc.issued_at, 'created_at', doc.created_at,
    'review_note', doc.review_note, 'revocation_reason', doc.revocation_reason,
    'has_pdf', doc.pdf_storage_path IS NOT NULL);
END;
$$;

-- Approve / reject / request changes. Approval is bound to the hash the practitioner was shown.
CREATE FUNCTION public.clinical_document_decide(
  p_actor uuid, p_doc uuid, p_decision text, p_expected_hash text, p_note text,
  p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  doc public.medical_documents;
  t public.document_templates;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  d := public._require_doctor(p_actor, doc.document_type = 'PRESCRIPTION_ORDER');
  IF doc.doctor_id <> d.id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  IF doc.status <> 'PENDING_DOCTOR_REVIEW' THEN
    RAISE EXCEPTION 'invalid_transition: the document is % and is not awaiting review', doc.status;
  END IF;
  IF p_decision NOT IN ('approve', 'reject', 'request_changes') THEN RAISE EXCEPTION 'invalid_input: decision'; END IF;

  IF p_decision = 'approve' THEN
    IF p_expected_hash IS DISTINCT FROM doc.document_hash THEN
      RAISE EXCEPTION 'hash_mismatch: the document you reviewed is not the document on file — reload and review again';
    END IF;
    IF doc.review_started_at IS NULL THEN
      RAISE EXCEPTION 'review_required: open the document for review before approving';
    END IF;
    SELECT * INTO t FROM public.document_templates WHERE id = doc.template_id;
    IF t.status <> 'ACTIVE' OR (t.effective_until IS NOT NULL AND t.effective_until <= now()) THEN
      RAISE EXCEPTION 'template_unavailable: the template is no longer active';
    END IF;
    IF doc.expires_at IS NOT NULL AND doc.expires_at <= now() THEN
      RAISE EXCEPTION 'invalid_input: the document has already passed its expiry date';
    END IF;
    IF doc.document_type = 'PRESCRIPTION_ORDER' THEN PERFORM public._validate_prescription(p_doc); END IF;
    UPDATE public.medical_documents SET status = 'APPROVED', approved_by = p_actor, approved_at = now() WHERE id = p_doc;
    PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'DOCTOR_APPROVED',
      jsonb_build_object('hash', doc.document_hash), p_ip, p_ua);
    RETURN jsonb_build_object('id', p_doc, 'status', 'APPROVED', 'document_hash', doc.document_hash);
  ELSIF p_decision = 'reject' THEN
    IF v_note IS NULL THEN RAISE EXCEPTION 'invalid_input: a reason is required'; END IF;
    UPDATE public.medical_documents SET status = 'VOID', voided_at = now(), review_note = left(v_note, 1000) WHERE id = p_doc;
    PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'DOCTOR_REJECTED', jsonb_build_object('action', 'reject'), p_ip, p_ua);
    PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'VOIDED', '{}'::jsonb, p_ip, p_ua);
    RETURN jsonb_build_object('id', p_doc, 'status', 'VOID');
  ELSE
    IF v_note IS NULL THEN RAISE EXCEPTION 'invalid_input: say what needs to change'; END IF;
    UPDATE public.medical_documents SET status = 'DRAFT', rendered_content = NULL, document_hash = NULL,
      review_started_at = NULL, review_note = left(v_note, 1000) WHERE id = p_doc;
    PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'DOCTOR_REJECTED', jsonb_build_object('action', 'request_changes'), p_ip, p_ua);
    RETURN jsonb_build_object('id', p_doc, 'status', 'DRAFT');
  END IF;
END;
$$;

-- Hand the approved document to a signature provider. The assurance of the method must meet the
-- recorded policy for the document type; an unconfirmed policy or provider blocks signing outright.
CREATE FUNCTION public.clinical_document_begin_signing(
  p_actor uuid, p_doc uuid, p_expected_hash text, p_provider text, p_unsigned_pdf_hash text,
  p_provider_request_id text, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
  doc public.medical_documents;
  prov public.signature_providers;
  pol public.document_signature_policy;
  v_sig uuid;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  d := public._require_doctor(p_actor, doc.document_type = 'PRESCRIPTION_ORDER');
  IF doc.doctor_id <> d.id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  IF doc.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'invalid_transition: the document must be approved by the practitioner before signing (it is %)', doc.status;
  END IF;
  IF p_expected_hash IS DISTINCT FROM doc.document_hash THEN
    RAISE EXCEPTION 'hash_mismatch: the document to be signed is not the document that was approved';
  END IF;
  IF doc.expires_at IS NOT NULL AND doc.expires_at <= now() THEN
    RAISE EXCEPTION 'invalid_input: the document has already passed its expiry date';
  END IF;
  SELECT * INTO prov FROM public.signature_providers WHERE provider = p_provider;
  IF NOT FOUND OR NOT prov.enabled OR prov.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'signature_provider_unavailable: this signature method has not been enabled and confirmed by compliance';
  END IF;
  SELECT * INTO pol FROM public.document_signature_policy WHERE document_type = doc.document_type;
  IF pol.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'signature_policy_unconfirmed: the required signature level for this document type has not been confirmed by compliance';
  END IF;
  IF public._assurance_rank(prov.assurance_level) < public._assurance_rank(pol.required_assurance) THEN
    RAISE EXCEPTION 'signature_level_insufficient: % documents require a % signature; this method is %',
      doc.document_type, pol.required_assurance, prov.assurance_level;
  END IF;
  IF prov.assurance_level <> 'SIMPLE' AND (d.signature_status <> 'enrolled' OR d.signature_provider IS DISTINCT FROM p_provider) THEN
    RAISE EXCEPTION 'signature_not_enrolled: the practitioner is not enrolled with this signature provider';
  END IF;
  IF p_unsigned_pdf_hash IS NULL OR p_unsigned_pdf_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_input: the pre-signature document hash is required';
  END IF;
  INSERT INTO public.document_signatures (document_id, doctor_id, signature_provider, signature_method, assurance_level,
      provider_request_id, document_hash_before_signature)
  VALUES (p_doc, d.id, prov.provider, prov.signature_method, prov.assurance_level, left(p_provider_request_id, 200),
      p_unsigned_pdf_hash)
  RETURNING id INTO v_sig;
  UPDATE public.medical_documents SET status = 'SIGNING' WHERE id = p_doc;
  PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'SIGNATURE_REQUESTED',
    jsonb_build_object('provider', prov.provider, 'assurance', prov.assurance_level), p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'SIGNING', 'signature_id', v_sig, 'assurance', prov.assurance_level);
END;
$$;

CREATE FUNCTION public.clinical_document_signing_failed(
  p_actor uuid, p_doc uuid, p_code text, p_cancelled boolean DEFAULT false, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  IF p_actor IS NOT NULL THEN
    SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
    IF NOT FOUND OR d.id <> doc.doctor_id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  END IF;
  IF doc.status <> 'SIGNING' THEN RAISE EXCEPTION 'invalid_transition: the document is not being signed'; END IF;
  UPDATE public.document_signatures SET status = CASE WHEN p_cancelled THEN 'CANCELLED' ELSE 'FAILED' END,
    failure_code = left(p_code, 60) WHERE document_id = p_doc AND status = 'PENDING';
  UPDATE public.medical_documents SET status = 'APPROVED' WHERE id = p_doc;
  PERFORM public._doc_event(p_doc, p_actor, CASE WHEN p_actor IS NULL THEN 'system' ELSE 'doctor' END, 'SIGNATURE_FAILED',
    jsonb_build_object('code', left(p_code, 60), 'cancelled', p_cancelled), p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'APPROVED');
END;
$$;

-- Record a provider-confirmed signature. The practitioner's explicit approval + a PENDING request already
-- exist; an unattended (webhook) completion is only possible for an external provider, never for the
-- internal SIMPLE attestation, which needs the practitioner present.
CREATE FUNCTION public.clinical_document_complete_signing(
  p_actor uuid, p_doc uuid, p_sig jsonb, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
  s public.document_signatures;
  v_signed_at timestamptz;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  IF doc.status <> 'SIGNING' THEN RAISE EXCEPTION 'invalid_transition: the document is not being signed'; END IF;
  SELECT * INTO s FROM public.document_signatures WHERE document_id = p_doc AND status = 'PENDING' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition: no pending signature request'; END IF;
  IF p_actor IS NOT NULL THEN
    SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
    IF NOT FOUND OR d.id <> doc.doctor_id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  ELSIF s.signature_provider = 'internal_simple' THEN
    RAISE EXCEPTION 'forbidden: an internal attestation can only be completed by the practitioner' USING ERRCODE = '42501';
  END IF;
  PERFORM public._json_only_keys(p_sig, ARRAY['signature_reference', 'signed_at', 'certificate_subject',
    'certificate_issuer', 'certificate_serial', 'hash_after', 'metadata'], 'signature');
  IF NULLIF(p_sig ->> 'signature_reference', '') IS NULL
     OR COALESCE(p_sig ->> 'hash_after', '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_input: signature reference and signed document hash are required';
  END IF;
  v_signed_at := COALESCE((p_sig ->> 'signed_at')::timestamptz, now());
  IF v_signed_at > now() + interval '5 minutes' THEN RAISE EXCEPTION 'invalid_input: signature time is in the future'; END IF;
  UPDATE public.document_signatures SET status = 'COMPLETED',
    signature_reference = left(p_sig ->> 'signature_reference', 300), signed_at = v_signed_at,
    certificate_subject = left(p_sig ->> 'certificate_subject', 300),
    certificate_issuer = left(p_sig ->> 'certificate_issuer', 300),
    certificate_serial = left(p_sig ->> 'certificate_serial', 120),
    document_hash_after_signature = p_sig ->> 'hash_after',
    signature_metadata = COALESCE(p_sig -> 'metadata', '{}'::jsonb)
  WHERE id = s.id;
  UPDATE public.medical_documents SET status = 'SIGNED' WHERE id = p_doc;
  PERFORM public._doc_event(p_doc, p_actor, CASE WHEN p_actor IS NULL THEN 'system' ELSE 'doctor' END, 'SIGNATURE_COMPLETED',
    jsonb_build_object('provider', s.signature_provider, 'assurance', s.assurance_level,
                       'hash_after', p_sig ->> 'hash_after'), p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'SIGNED', 'assurance', s.assurance_level);
END;
$$;

CREATE FUNCTION public.clinical_document_issue(
  p_actor uuid, p_doc uuid, p_pdf_path text, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  IF p_actor IS NOT NULL THEN
    SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
    IF NOT FOUND OR d.id <> doc.doctor_id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  END IF;
  IF doc.status <> 'SIGNED' THEN RAISE EXCEPTION 'invalid_transition: only a signed document can be issued (it is %)', doc.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.document_signatures WHERE document_id = p_doc AND status = 'COMPLETED') THEN
    RAISE EXCEPTION 'invalid_transition: no completed signature on record';
  END IF;
  IF p_pdf_path IS NULL OR p_pdf_path !~ ('^' || doc.member_id::text || '/' || doc.id::text
       || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$') THEN
    RAISE EXCEPTION 'invalid_input: unexpected storage path';
  END IF;
  UPDATE public.medical_documents SET status = 'ISSUED', issued_at = now(), pdf_storage_path = p_pdf_path WHERE id = p_doc;
  PERFORM public._doc_event(p_doc, p_actor, CASE WHEN p_actor IS NULL THEN 'system' ELSE 'doctor' END, 'ISSUED', '{}'::jsonb, p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'ISSUED', 'member_id', doc.member_id);
END;
$$;

-- Pre-signature withdrawal by the practitioner.
CREATE FUNCTION public.clinical_document_void(p_actor uuid, p_doc uuid, p_reason text, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  d := public._require_doctor(p_actor, false);
  IF doc.doctor_id <> d.id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  IF doc.status NOT IN ('DRAFT', 'PENDING_DOCTOR_REVIEW', 'APPROVED') THEN
    RAISE EXCEPTION 'invalid_transition: a document in % cannot be voided (revoke it instead)', doc.status;
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'invalid_input: a reason is required'; END IF;
  UPDATE public.medical_documents SET status = 'VOID', voided_at = now(), review_note = left(btrim(p_reason), 1000) WHERE id = p_doc;
  PERFORM public._doc_event(p_doc, p_actor, 'doctor', 'VOIDED', '{}'::jsonb, p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'VOID');
END;
$$;

-- Revocation of a signed document: the practitioner of record, or an administrator (audited as such).
-- An administrator revokes; they cannot edit, re-issue or sign.
CREATE FUNCTION public.clinical_document_revoke(p_actor uuid, p_doc uuid, p_reason text, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
  v_role text;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor AND is_active;
  IF FOUND AND d.id = doc.doctor_id THEN
    v_role := 'doctor';
  ELSE
    PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
    v_role := 'admin';
  END IF;
  IF doc.status NOT IN ('SIGNED', 'ISSUED', 'EXPIRED') THEN
    RAISE EXCEPTION 'invalid_transition: a document in % cannot be revoked', doc.status;
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 3 THEN RAISE EXCEPTION 'invalid_input: a reason is required'; END IF;
  UPDATE public.medical_documents SET status = 'REVOKED', revoked_at = now(), revoked_by = p_actor,
    revocation_reason = left(btrim(p_reason), 500) WHERE id = p_doc;
  PERFORM public._doc_event(p_doc, p_actor, v_role, 'REVOKED', '{}'::jsonb, p_ip, p_ua);
  RETURN jsonb_build_object('id', p_doc, 'status', 'REVOKED');
END;
$$;

-- Moves overdue documents to EXPIRED (run from the maintenance cron; verification does not depend on it).
CREATE FUNCTION public.clinical_document_expire_due() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN SELECT id FROM public.medical_documents
           WHERE status = 'ISSUED' AND expires_at IS NOT NULL AND expires_at <= now()
           ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.medical_documents SET status = 'EXPIRED' WHERE id = r.id;
    PERFORM public._doc_event(r.id, NULL, 'system', 'EXPIRED');
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- Log a notification outcome (no content, no address).
CREATE FUNCTION public.clinical_document_log_notification(p_doc uuid, p_ok boolean, p_channel text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public._doc_event(p_doc, NULL, 'system', CASE WHEN p_ok THEN 'NOTIFICATION_SENT' ELSE 'NOTIFICATION_FAILED' END,
    jsonb_build_object('channel', left(p_channel, 20)));
$$;

-- ---------------------------------------------------------------------------
-- 12. Reads (each authorises the caller itself; the PDF/clinical content never leaves without an audit row)
-- ---------------------------------------------------------------------------

-- Authorise access to the stored PDF. Members: their own ISSUED/EXPIRED documents. Practitioners: their own.
-- Everyone else, administrators included, is refused.
CREATE FUNCTION public.clinical_document_access(
  p_actor uuid, p_doc uuid, p_kind text, p_ip text DEFAULT NULL, p_ua text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
  v_role text;
BEGIN
  IF p_kind NOT IN ('VIEWED', 'DOWNLOADED') THEN RAISE EXCEPTION 'invalid_input: access kind'; END IF;
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc;
  IF NOT FOUND OR p_actor IS NULL THEN RAISE EXCEPTION 'document_not_found'; END IF;
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
  IF FOUND AND d.id = doc.doctor_id THEN
    v_role := 'doctor';
  ELSIF doc.member_id = p_actor AND doc.status IN ('ISSUED', 'EXPIRED') THEN
    v_role := 'member';
  ELSE
    RAISE EXCEPTION 'document_not_found';
  END IF;
  IF doc.pdf_storage_path IS NULL THEN RAISE EXCEPTION 'document_not_ready: the document has not been issued yet'; END IF;
  PERFORM public._doc_event(p_doc, p_actor, v_role, p_kind, '{}'::jsonb, p_ip, p_ua);
  RETURN jsonb_build_object('path', doc.pdf_storage_path, 'document_id', doc.document_id, 'status', doc.status);
END;
$$;

CREATE FUNCTION public.member_list_documents(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', d.id, 'document_id', d.document_id, 'document_type', d.document_type,
    'status', CASE WHEN d.status = 'ISSUED' AND d.expires_at IS NOT NULL AND d.expires_at <= now() THEN 'EXPIRED' ELSE d.status END,
    'issued_at', d.issued_at, 'expires_at', d.expires_at, 'verification_token', d.verification_token,
    'practitioner', btrim(dp.title || ' ' || dp.first_name || ' ' || dp.last_name))
    ORDER BY d.issued_at DESC NULLS LAST), '[]'::jsonb)
  FROM public.medical_documents d JOIN public.doctor_profiles dp ON dp.id = d.doctor_id
  WHERE d.member_id = p_user AND d.status IN ('ISSUED', 'EXPIRED', 'REVOKED');
$$;

CREATE FUNCTION public.doctor_list_patients(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
BEGIN
  d := public._require_doctor(p_actor, false);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'member_id', a.member_id, 'member_ref', public._member_ref(a.member_id),
      'full_name', pr.full_name, 'date_of_birth', pr.date_of_birth,
      'identity_verified', cv.status = 'verified',
      'documents', (SELECT count(*) FROM public.medical_documents md WHERE md.member_id = a.member_id AND md.doctor_id = d.id))
      ORDER BY pr.full_name)
    FROM public.doctor_patient_assignments a
    JOIN public.profiles pr ON pr.id = a.member_id
    LEFT JOIN public.customer_verification cv ON cv.user_id = a.member_id
    WHERE a.doctor_id = d.id AND a.status = 'active'), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.doctor_list_documents(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
BEGIN
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden: practitioner profile required' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', md.id, 'document_id', md.document_id, 'document_type', md.document_type,
      'status', CASE WHEN md.status = 'ISSUED' AND md.expires_at IS NOT NULL AND md.expires_at <= now() THEN 'EXPIRED' ELSE md.status END,
      'patient', pr.full_name, 'member_id', md.member_id, 'created_at', md.created_at,
      'issued_at', md.issued_at, 'expires_at', md.expires_at, 'template_version', md.template_version,
      'document_version', md.document_version) ORDER BY md.created_at DESC)
    FROM public.medical_documents md JOIN public.profiles pr ON pr.id = md.member_id
    WHERE md.doctor_id = d.id), '[]'::jsonb);
END;
$$;

-- Administrator oversight: operational metadata only. No snapshot, no rendered text, no prescription values.
CREATE FUNCTION public.clinical_document_admin_list(p_actor uuid, p_status text DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  RETURN COALESCE((
    SELECT jsonb_agg(j ORDER BY (j ->> 'created_at') DESC) FROM (
      SELECT jsonb_build_object(
        'id', md.id, 'document_id', md.document_id, 'document_type', md.document_type,
        'status', md.status, 'practitioner', btrim(dp.title || ' ' || dp.first_name || ' ' || dp.last_name),
        'member_ref', public._member_ref(md.member_id), 'template_version', md.template_version,
        'document_version', md.document_version, 'created_at', md.created_at, 'issued_at', md.issued_at,
        'expires_at', md.expires_at, 'revoked_at', md.revoked_at, 'revocation_reason', md.revocation_reason,
        'signature_status', (SELECT s.status FROM public.document_signatures s WHERE s.document_id = md.id
                             ORDER BY s.created_at DESC LIMIT 1),
        'assurance', (SELECT s.assurance_level FROM public.document_signatures s WHERE s.document_id = md.id
                      ORDER BY s.created_at DESC LIMIT 1)) AS j
      FROM public.medical_documents md JOIN public.doctor_profiles dp ON dp.id = md.doctor_id
      WHERE p_status IS NULL OR md.status = p_status
      ORDER BY md.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 500)) x), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.clinical_document_admin_events(p_actor uuid, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  RETURN COALESCE((
    SELECT jsonb_agg(j ORDER BY (j ->> 'id')::bigint DESC) FROM (
      SELECT jsonb_build_object('id', e.id, 'document_id', md.document_id, 'event_type', e.event_type,
        'actor_role', e.actor_role, 'created_at', e.created_at, 'ip_address', e.ip_address) AS j
      FROM public.document_events e JOIN public.medical_documents md ON md.id = e.document_id
      ORDER BY e.id DESC LIMIT LEAST(GREATEST(p_limit, 1), 1000)) x), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.clinical_document_doctor_events(p_actor uuid, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  d public.doctor_profiles;
BEGIN
  d := public._require_doctor(p_actor, false);
  RETURN COALESCE((
    SELECT jsonb_agg(j ORDER BY (j ->> 'id')::bigint DESC) FROM (
      SELECT jsonb_build_object('id', e.id, 'document_id', md.document_id, 'event_type', e.event_type,
        'actor_role', e.actor_role, 'created_at', e.created_at) AS j
      FROM public.document_events e JOIN public.medical_documents md ON md.id = e.document_id
      WHERE md.doctor_id = d.id ORDER BY e.id DESC LIMIT LEAST(GREATEST(p_limit, 1), 1000)) x), '[]'::jsonb);
END;
$$;

-- Templates visible to the caller (practitioner or admin), without exposing anything clinical.
CREATE FUNCTION public.template_list(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.doctor_profiles WHERE user_id = p_actor AND is_active AND verification_status = 'verified') THEN
    PERFORM public._assert_staff(p_actor, 'admin'::public.app_role);
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.document_type, t.name, t.version DESC)
    FROM public.document_templates t), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- 13. Public verification (service role only; reveals the minimum)
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.document_verify_rate_check(p_bucket text, p_limit integer, p_window_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_window timestamptz := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_n integer;
BEGIN
  INSERT INTO public.document_verify_attempts (bucket, window_start, attempts) VALUES (left(p_bucket, 100), v_window, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET attempts = public.document_verify_attempts.attempts + 1
  RETURNING attempts INTO v_n;
  DELETE FROM public.document_verify_attempts WHERE window_start < now() - interval '1 day' AND random() < 0.01;
  RETURN v_n <= p_limit;
END;
$$;

CREATE FUNCTION public.document_verify_lookup(p_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  dp public.doctor_profiles;
  s public.document_signatures;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  SELECT * INTO doc FROM public.medical_documents WHERE verification_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  SELECT * INTO dp FROM public.doctor_profiles WHERE id = doc.doctor_id;
  SELECT * INTO s FROM public.document_signatures WHERE document_id = doc.id AND status = 'COMPLETED';
  RETURN jsonb_build_object(
    'found', true, 'id', doc.id, 'document_id', doc.document_id, 'document_type', doc.document_type,
    'status', CASE WHEN doc.status = 'ISSUED' AND doc.expires_at IS NOT NULL AND doc.expires_at <= now() THEN 'EXPIRED' ELSE doc.status END,
    'issued_at', doc.issued_at, 'expires_at', doc.expires_at,
    'practitioner', btrim(dp.title || ' ' || dp.first_name || ' ' || dp.last_name),
    'registration_verified', dp.verification_status = 'verified',
    'stored_hash', doc.document_hash,
    'content_hash_ok', doc.rendered_content IS NOT NULL AND public._sha256_hex(doc.rendered_content) = doc.document_hash,
    'signature_completed', s.id IS NOT NULL,
    'assurance', s.assurance_level,
    'pdf_path', doc.pdf_storage_path,
    'pdf_hash_expected', s.document_hash_after_signature);
END;
$$;

CREATE FUNCTION public.document_verify_record(p_doc uuid, p_token text, p_status text, p_observed_hash text, p_requester_hash text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.document_verifications (document_id, verification_token, document_hash, verification_status, requester_hash)
  VALUES (p_doc, p_token, p_observed_hash, p_status, left(p_requester_hash, 64));
  PERFORM public._doc_event(p_doc, NULL, 'system', 'VERIFIED', jsonb_build_object('result', p_status));
END;
$$;

-- ---------------------------------------------------------------------------
-- 14. Privileges: every function is service_role only
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'clinical\_document\_%' OR p.proname LIKE 'doctor\_%' OR p.proname LIKE 'template\_%'
           OR p.proname LIKE 'signature\_%' OR p.proname LIKE 'document\_verify\_%'
           OR p.proname IN ('member_list_documents', '_doc_event', '_require_doctor', '_template_author',
                            '_template_validate', '_next_document_number', '_snapshot_identity',
                            '_validate_prescription', '_sha256_hex', '_member_ref', '_json_only_keys', '_clean_text',
                            '_assurance_rank', '_today_sast', '_rx_required_keys', '_template_allowed_keys',
                            '_deny_mutation', '_deny_delete', '_medical_documents_guard', '_prescription_orders_guard',
                            '_prescription_status_sync', '_document_templates_guard', '_document_signatures_guard'))
      AND p.proname <> '_current_doctor_id'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 15. Seed templates: DRAFT only, wording is a placeholder, and they cannot be activated until a
--     practitioner replaces the text (the marker below blocks approval).
-- ---------------------------------------------------------------------------

INSERT INTO public.document_templates (document_type, name, version, status, template_content, template_schema, change_note)
VALUES
('MEDICAL_LETTER', 'Medical letter', 1, 'DRAFT',
$tpl$[[SEED-PLACEHOLDER]] Replace this wording with the practitioner-approved medical letter text before approval.

CannaPlug — Medical Letter
Document ID: {{document.document_id}}
Date: {{document.issue_date}}

Patient: {{member.full_name}}
Member reference: {{member.member_id}}
Date of birth: {{member.date_of_birth}}

{{clinical.statement}}

Practitioner: {{doctor.title}} {{doctor.full_name}}
{{doctor.qualification}}
HPCSA registration number: {{doctor.hpcsa_number}}
Practice number: {{doctor.practice_number}}
{{doctor.practice_name}}
{{doctor.practice_address}}
Tel: {{doctor.practice_phone}}   Email: {{doctor.practice_email}}
Valid until: {{document.expiry_date}}$tpl$,
'{"placeholders":[
 {"key":"document.document_id","required":true,"label":"Document ID"},
 {"key":"document.issue_date","required":true,"label":"Issue date"},
 {"key":"document.expiry_date","required":false,"label":"Expiry date"},
 {"key":"member.full_name","required":true,"label":"Member name"},
 {"key":"member.member_id","required":true,"label":"Member reference"},
 {"key":"member.date_of_birth","required":true,"label":"Date of birth"},
 {"key":"clinical.statement","required":true,"clinical":true,"label":"Practitioner statement"},
 {"key":"doctor.title","required":true,"label":"Title"},
 {"key":"doctor.full_name","required":true,"label":"Practitioner name"},
 {"key":"doctor.qualification","required":false,"label":"Qualification"},
 {"key":"doctor.hpcsa_number","required":true,"label":"HPCSA number"},
 {"key":"doctor.practice_number","required":false,"label":"Practice number"},
 {"key":"doctor.practice_name","required":false,"label":"Practice name"},
 {"key":"doctor.practice_address","required":false,"label":"Practice address"},
 {"key":"doctor.practice_phone","required":false,"label":"Practice phone"},
 {"key":"doctor.practice_email","required":false,"label":"Practice email"}]}'::jsonb,
 'Seed skeleton. Awaiting the practitioner-approved wording.'),
('PRESCRIPTION_ORDER', 'Prescription order', 1, 'DRAFT',
$tpl$[[SEED-PLACEHOLDER]] Replace this layout with the practitioner/pharmacist-approved prescription template before approval.

CannaPlug — Prescription / Order
Document ID: {{document.document_id}}
Date: {{document.issue_date}}
Valid until: {{document.expiry_date}}

Patient: {{member.full_name}}
Member reference: {{member.member_id}}
Date of birth: {{member.date_of_birth}}

Medicine: {{prescription.medicine_name}}
Generic name: {{prescription.generic_name}}
Dosage form: {{prescription.dosage_form}}
Strength: {{prescription.strength}}
Quantity: {{prescription.quantity_numeric}} ({{prescription.quantity_words}})
Route: {{prescription.route}}
Frequency: {{prescription.frequency}}
Duration: {{prescription.duration}}
Repeats: {{prescription.repeats}}
Indication: {{prescription.indication}}
Directions: {{prescription.directions}}
Special instructions: {{prescription.special_instructions}}

Prescriber: {{doctor.title}} {{doctor.full_name}}
{{doctor.qualification}}
HPCSA registration number: {{doctor.hpcsa_number}}
Practice number: {{doctor.practice_number}}
{{doctor.practice_name}}
{{doctor.practice_address}}
Tel: {{doctor.practice_phone}}$tpl$,
'{"placeholders":[
 {"key":"document.document_id","required":true},{"key":"document.issue_date","required":true},
 {"key":"document.expiry_date","required":true},
 {"key":"member.full_name","required":true},{"key":"member.member_id","required":true},{"key":"member.date_of_birth","required":true},
 {"key":"prescription.medicine_name","required":true,"clinical":true},
 {"key":"prescription.generic_name","required":false,"clinical":true},
 {"key":"prescription.dosage_form","required":true,"clinical":true},
 {"key":"prescription.strength","required":true,"clinical":true},
 {"key":"prescription.quantity_numeric","required":true,"clinical":true},
 {"key":"prescription.quantity_words","required":true,"clinical":true},
 {"key":"prescription.route","required":true,"clinical":true},
 {"key":"prescription.frequency","required":true,"clinical":true},
 {"key":"prescription.duration","required":true,"clinical":true},
 {"key":"prescription.repeats","required":true,"clinical":true},
 {"key":"prescription.indication","required":true,"clinical":true},
 {"key":"prescription.directions","required":true,"clinical":true},
 {"key":"prescription.special_instructions","required":false,"clinical":true},
 {"key":"doctor.title","required":true},{"key":"doctor.full_name","required":true},{"key":"doctor.qualification","required":false},
 {"key":"doctor.hpcsa_number","required":true},{"key":"doctor.practice_number","required":false},
 {"key":"doctor.practice_name","required":false},{"key":"doctor.practice_address","required":false},
 {"key":"doctor.practice_phone","required":false}]}'::jsonb,
 'Seed skeleton. Awaiting the practitioner/pharmacist-approved prescription template.');

-- ---------------------------------------------------------------------------
-- 16. Asynchronous providers: remember the provider's request id on the pending signature
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.clinical_document_set_provider_request(p_actor uuid, p_doc uuid, p_request_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  doc public.medical_documents;
  d public.doctor_profiles;
BEGIN
  SELECT * INTO doc FROM public.medical_documents WHERE id = p_doc FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'document_not_found'; END IF;
  SELECT * INTO d FROM public.doctor_profiles WHERE user_id = p_actor;
  IF NOT FOUND OR d.id <> doc.doctor_id THEN RAISE EXCEPTION 'forbidden: not your document' USING ERRCODE = '42501'; END IF;
  IF doc.status <> 'SIGNING' THEN RAISE EXCEPTION 'invalid_transition: the document is not being signed'; END IF;
  UPDATE public.document_signatures SET provider_request_id = left(p_request_id, 200)
  WHERE document_id = p_doc AND status = 'PENDING';
  RETURN jsonb_build_object('id', p_doc);
END;
$$;
REVOKE ALL ON FUNCTION public.clinical_document_set_provider_request(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clinical_document_set_provider_request(uuid, uuid, text) TO service_role;

-- Read-only companion to document_verify_rate_check: has this bucket already reached its limit in the window?
CREATE FUNCTION public.document_verify_blocked(p_bucket text, p_limit integer, p_window_seconds integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE((SELECT a.attempts FROM public.document_verify_attempts a
                   WHERE a.bucket = left(p_bucket, 100)
                     AND a.window_start = to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds)), 0) >= p_limit;
$$;
REVOKE ALL ON FUNCTION public.document_verify_blocked(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_verify_blocked(text, integer, integer) TO service_role;
