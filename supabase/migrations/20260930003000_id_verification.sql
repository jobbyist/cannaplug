-- ID verification for members: sign-up captures a date of birth, the member then uploads an ID document
-- (private storage, never publicly readable) and a manager approves or rejects it by hand from /admin.
-- Placing an online order requires an approved verification.
--
--   * customer_verification   + document/declared-DOB/review columns, a pending-needs-evidence CHECK, and
--                             NO client write path any more (managers used to be able to UPDATE status
--                             directly, which skipped the review trail); members read a column-limited view
--   * verification_submit     member -> pending (18+ checked here, attempt cap, own-folder path only)
--   * verification_review     manager+ approve / reject (reason required), never your own record, audited
--   * verification_log_document_view   audit-before-access for every ID image a staff member opens
--   * _require_verified_member  the order gate, called by checkout_place_order and create_reorder
--   * storage bucket id-documents  private, 5 MB, images/PDF only; no storage policies => service role only
--   * Realtime                customer_verification joins the publication so /account reflects a decision live
--
-- Deliberate non-goals: automated document/face matching (a provider integration, see CANNAPLUG.md) and
-- document retention/purge scheduling (needs a business + POPIA decision, recorded as an open item).

ALTER TABLE public.customer_verification
  ADD COLUMN IF NOT EXISTS document_type text
    CHECK (document_type IS NULL OR document_type IN ('sa_id', 'passport', 'drivers_licence')),
  ADD COLUMN IF NOT EXISTS document_path text,
  ADD COLUMN IF NOT EXISTS declared_dob date,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_code text
    CHECK (rejection_code IS NULL OR rejection_code IN
      ('unreadable', 'expired_document', 'name_mismatch', 'dob_mismatch', 'underage', 'other')),
  ADD COLUMN IF NOT EXISTS rejection_note text CHECK (rejection_note IS NULL OR length(rejection_note) <= 500),
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

-- A pending review always has the evidence a reviewer needs; an approval always says who and when.
ALTER TABLE public.customer_verification
  ADD CONSTRAINT customer_verification_pending_evidence_chk
    CHECK (status <> 'pending' OR (document_path IS NOT NULL AND document_type IS NOT NULL
                                   AND declared_dob IS NOT NULL AND submitted_at IS NOT NULL)),
  ADD CONSTRAINT customer_verification_verified_chk
    CHECK (status <> 'verified' OR (verified_at IS NOT NULL AND verified_by IS NOT NULL));

CREATE INDEX IF NOT EXISTS customer_verification_pending_idx
  ON public.customer_verification (submitted_at) WHERE status = 'pending';

-- Writes only through the functions below (service role). Reads: a member sees their own row, staff see
-- all, but no client role can read the storage path or the declared date of birth directly.
DROP POLICY IF EXISTS "verification management insert" ON public.customer_verification;
DROP POLICY IF EXISTS "verification management update" ON public.customer_verification;
REVOKE ALL ON public.customer_verification FROM anon, authenticated;
GRANT ALL ON public.customer_verification TO service_role;
GRANT SELECT (user_id, status, method, document_type, submitted_at, reviewed_at, verified_at,
              rejection_code, rejection_note, attempt_count, updated_at)
  ON public.customer_verification TO authenticated;

-- Live decision updates on /account (RLS + the column grant above decide what a subscriber receives).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                       AND tablename = 'customer_verification') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_verification;
  END IF;
END
$$;

-- Private bucket. storage.objects has RLS enabled and we add no policies, so anon/authenticated can
-- neither list, read nor write it: uploads use server-minted signed upload URLs and reviewers read
-- through short-lived signed URLs, both created with the service role.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('id-documents', 'id-documents', false, 5242880,
            ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    ON CONFLICT (id) DO UPDATE
      SET public = false, file_size_limit = 5242880,
          allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- The order gate
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Member: submit an ID for review
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Staff: open an ID image (audit first, then the server signs a short-lived URL)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.verification_log_document_view(p_actor uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.customer_verification;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  SELECT * INTO v_row FROM public.customer_verification WHERE user_id = p_user_id;
  IF NOT FOUND OR v_row.document_path IS NULL THEN
    RAISE EXCEPTION 'verification_not_found';
  END IF;
  INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, target_user_id, metadata)
  VALUES (p_actor, 'id_document_viewed', 'customer_verification', p_user_id, p_user_id,
          jsonb_build_object('document_type', v_row.document_type, 'status', v_row.status));
  RETURN jsonb_build_object('path', v_row.document_path, 'document_type', v_row.document_type);
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff: decide
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- The two member order entry points, now gated (text identical to the checkout migration apart from the
-- _require_verified_member line)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.checkout_place_order(
  p_user_id uuid,
  p_items jsonb,
  p_contact_name text,
  p_contact_phone text,
  p_delivery_method text,
  p_address_id uuid,
  p_payment_method text,
  p_expected_total numeric,
  p_notes text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_quote jsonb;
  v_address public.addresses;
  v_snapshot jsonb;
  v_bad text;
  v_result jsonb;
  v_order public.orders;
  c_hold constant integer := 120;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._require_verified_member(p_user_id);
  IF p_expected_total IS NULL THEN
    RAISE EXCEPTION 'expected_total_required: confirm the current total before placing the order';
  END IF;
  IF p_payment_method IS DISTINCT FROM 'eft' THEN
    RAISE EXCEPTION 'payment_method_unsupported: only EFT is available right now';
  END IF;
  IF length(btrim(COALESCE(p_contact_name, ''))) NOT BETWEEN 2 AND 160
     OR COALESCE(p_contact_phone, '') !~ '^[0-9+() -]{7,40}$' THEN
    RAISE EXCEPTION 'invalid_contact: a name and a valid phone number are required';
  END IF;

  v_cached := public._idem_begin('checkout', p_user_id, p_idempotency_key,
    jsonb_build_object('items', p_items, 'name', p_contact_name, 'phone', p_contact_phone,
                       'method', p_delivery_method, 'address', p_address_id, 'pay', p_payment_method,
                       'total', p_expected_total, 'notes', p_notes));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- Ownership is part of the lookup: another member's address is indistinguishable from a missing one.
  SELECT * INTO v_address FROM public.addresses WHERE id = p_address_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'address_not_found';
  END IF;
  IF COALESCE(btrim(v_address.city), '') = '' AND COALESCE(btrim(v_address.suburb), '') = '' THEN
    RAISE EXCEPTION 'address_incomplete: add a suburb or city to this address';
  END IF;
  v_snapshot := jsonb_build_object(
    'label', v_address.label, 'recipient_name', v_address.recipient_name, 'phone', v_address.phone,
    'line1', v_address.line1, 'line2', v_address.line2, 'suburb', v_address.suburb, 'city', v_address.city,
    'province', v_address.province, 'postal_code', v_address.postal_code, 'country', v_address.country,
    'delivery_notes', v_address.delivery_notes);

  v_quote := public.checkout_quote(p_items, p_delivery_method);
  IF NOT (v_quote->>'orderable')::boolean THEN
    SELECT string_agg(l->>'name', ', ') INTO v_bad
    FROM jsonb_array_elements(v_quote->'lines') l WHERE l->>'status' <> 'ok';
    RAISE EXCEPTION 'checkout_unavailable: %', COALESCE(v_bad, 'no items');
  END IF;
  IF (v_quote->>'total')::numeric IS DISTINCT FROM p_expected_total THEN
    RAISE EXCEPTION 'price_changed: the current total is R%', (v_quote->>'total');
  END IF;

  -- Server pricing + stock hold (an unpaid EFT order keeps its stock for c_hold minutes).
  v_result := public.create_online_order(
    p_user_id,
    (SELECT jsonb_agg(jsonb_build_object('product_id', l->>'product_id', 'quantity', (l->>'quantity')::integer))
     FROM jsonb_array_elements(v_quote->'lines') l),
    btrim(p_contact_name), btrim(p_contact_phone), p_notes,
    'co-' || md5(p_idempotency_key), c_hold);

  PERFORM public._checkout_apply_delivery((v_result->>'order_id')::uuid, p_delivery_method, v_snapshot, p_payment_method);
  SELECT * INTO v_order FROM public.orders WHERE id = (v_result->>'order_id')::uuid;

  PERFORM public._audit(p_user_id, 'checkout_order_placed', 'order', v_order.id,
    jsonb_build_object('order_number', v_order.order_number, 'total', v_order.total_rand,
                       'delivery', p_delivery_method, 'payment', p_payment_method));
  v_result := jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'status', v_order.status,
    'subtotal', (v_quote->>'subtotal')::numeric, 'delivery_fee', v_order.delivery_fee_rand,
    'total', v_order.total_rand, 'payment_method', v_order.payment_method, 'hold_minutes', c_hold);
  RETURN public._idem_finish('checkout', p_user_id, p_idempotency_key, v_result);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_reorder(
  p_user_id uuid,
  p_source_order_id uuid,
  p_expected_total numeric,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_check jsonb;
  v_source public.orders;
  v_items jsonb;
  v_result jsonb;
  v_bad text;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._require_verified_member(p_user_id);
  IF p_expected_total IS NULL THEN
    RAISE EXCEPTION 'expected_total_required: confirm the current total before reordering';
  END IF;
  v_cached := public._idem_begin('reorder', p_user_id, p_idempotency_key,
    jsonb_build_object('order', p_source_order_id, 'total', p_expected_total));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  v_check := public.reorder_check(p_user_id, p_source_order_id);
  IF NOT (v_check->>'orderable')::boolean THEN
    SELECT string_agg(l->>'name', ', ') INTO v_bad
    FROM jsonb_array_elements(v_check->'lines') l WHERE l->>'status' IN ('unavailable', 'insufficient_stock');
    RAISE EXCEPTION 'reorder_unavailable: %', COALESCE(v_bad, 'no items');
  END IF;
  IF (v_check->>'current_total')::numeric IS DISTINCT FROM p_expected_total THEN
    RAISE EXCEPTION 'price_changed: the current total is R%', (v_check->>'current_total');
  END IF;

  SELECT * INTO v_source FROM public.orders WHERE id = p_source_order_id AND user_id = p_user_id;
  SELECT jsonb_agg(jsonb_build_object('product_id', l->>'product_id', 'quantity', (l->>'quantity')::integer))
  INTO v_items FROM jsonb_array_elements(v_check->'lines') l;

  v_result := public.create_online_order(
    p_user_id, v_items, v_source.contact_name, v_source.contact_phone,
    'Reorder of ' || v_source.order_number, 'ro-' || md5(p_idempotency_key), 120);
  -- Carry the delivery method, address snapshot and payment method over (fee re-priced today).
  IF v_source.delivery_method IS NOT NULL THEN
    PERFORM public._checkout_apply_delivery((v_result->>'order_id')::uuid, v_source.delivery_method,
      v_source.delivery_address, COALESCE(v_source.payment_method, 'eft'));
    v_result := v_result || jsonb_build_object('total',
      (SELECT o.total_rand FROM public.orders o WHERE o.id = (v_result->>'order_id')::uuid));
  END IF;
  v_result := v_result || jsonb_build_object('source_order_id', p_source_order_id);
  RETURN public._idem_finish('reorder', p_user_id, p_idempotency_key, v_result);
END;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: service role only
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY['_require_verified_member', 'verification_submit',
                                 'verification_log_document_view', 'verification_review',
                                 'checkout_place_order', 'create_reorder'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;
