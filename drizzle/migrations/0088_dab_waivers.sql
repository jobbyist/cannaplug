-- 27 Nov 2026: Cannaplug dab hit waiver, health screening and indemnity declaration, signed on the till.
--   * products.requires_waiver: tick it on the dab hit product. A till sale that contains such a product needs a valid waiver.
--   * dab_waivers: one signed waiver per visit. It is valid for one sale, on the day it was signed (South African day).
--     "Declined" waivers (under 18, under the influence, pregnant or breastfeeding, or staff concern) are kept as a record but
--     can never be used for a sale.
--   * Section 2 holds health answers (POPIA special personal information): only managers and admins can read a waiver.
--     Budtenders can create one and see whether it passed, nothing more. Nothing here is reachable from the browser.
--   * Kept for 3 years from signing, then deleted by a daily job.
--   * The audit log gets who and what, never names or health answers.
-- Rollback: supabase/rollbacks/20261127012000_dab_waivers_rollback.sql.

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS requires_waiver boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.products.requires_waiver IS
  'A till sale containing this product needs a valid signed dab waiver (see dab_waivers).';

CREATE TABLE IF NOT EXISTS public.dab_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL DEFAULT (now() + interval '3 years'),
  status text NOT NULL CHECK (status IN ('valid', 'declined')),
  decline_reasons text[] NOT NULL DEFAULT '{}',
  flagged boolean NOT NULL DEFAULT false,
  customer_name text NOT NULL CHECK (length(btrim(customer_name)) BETWEEN 2 AND 120),
  date_of_birth date NOT NULL CHECK (date_of_birth > DATE '1900-01-01'),
  id_number text NOT NULL CHECK (length(btrim(id_number)) BETWEEN 4 AND 40),
  age_confirmed boolean NOT NULL,
  popia_consent boolean NOT NULL,
  screening jsonb NOT NULL,
  emergency_name text NOT NULL CHECK (length(btrim(emergency_name)) BETWEEN 2 AND 120),
  emergency_relationship text CHECK (emergency_relationship IS NULL OR length(emergency_relationship) <= 60),
  emergency_phone text NOT NULL CHECK (length(btrim(emergency_phone)) BETWEEN 7 AND 30),
  emergency_alt_phone text CHECK (emergency_alt_phone IS NULL OR length(emergency_alt_phone) <= 30),
  signature text CHECK (signature IS NULL OR (signature ~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' AND length(signature) <= 200000)),
  staff_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  staff_name text NOT NULL,
  staff_noted_signs boolean NOT NULL DEFAULT false,
  staff_details text CHECK (staff_details IS NULL OR length(staff_details) <= 1000),
  claimed_at timestamptz,
  claim_key text,
  sale_id uuid REFERENCES public.pos_sales(id) ON DELETE SET NULL,
  incident jsonb,
  CONSTRAINT dab_waivers_valid_needs_signature CHECK (status <> 'valid' OR (signature IS NOT NULL AND age_confirmed AND popia_consent)),
  CONSTRAINT dab_waivers_valid_has_no_decline CHECK (status <> 'valid' OR decline_reasons = '{}')
);
CREATE INDEX IF NOT EXISTS dab_waivers_signed_idx ON public.dab_waivers (signed_at DESC);
CREATE INDEX IF NOT EXISTS dab_waivers_retain_idx ON public.dab_waivers (retain_until);
CREATE INDEX IF NOT EXISTS dab_waivers_sale_idx ON public.dab_waivers (sale_id) WHERE sale_id IS NOT NULL;
ALTER TABLE public.dab_waivers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dab_waivers FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dab_waivers TO service_role;

-- Create ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dab_waiver_create(p_actor uuid, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_role public.app_role;
  v_staff_name text;
  v_today date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_dob date;
  v_age integer;
  v_name text := btrim(COALESCE(p_payload->>'customer_name', ''));
  v_id text := btrim(COALESCE(p_payload->>'id_number', ''));
  v_conditions text[];
  v_allowed text[] := ARRAY['asthma', 'heart', 'epilepsy', 'low_bp', 'anxiety', 'pregnant', 'other'];
  v_alcohol boolean := COALESCE((p_payload->'alcohol'->>'had')::boolean, false);
  v_drugs boolean := COALESCE((p_payload->'drugs'->>'had')::boolean, false);
  v_meds boolean := COALESCE((p_payload->'medication'->>'had')::boolean, false);
  v_influence boolean := COALESCE((p_payload->>'under_influence')::boolean, false);
  v_staff_signs boolean := COALESCE((p_payload->>'staff_noted_signs')::boolean, false);
  v_decline text[] := '{}';
  v_status text;
  v_flagged boolean;
  v_signature text := NULLIF(p_payload->>'signature', '');
  v_screening jsonb;
  v_id_new uuid;
BEGIN
  v_role := public._assert_staff(p_actor, 'budtender');
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'waiver_invalid: details required'; END IF;
  IF length(v_name) < 2 THEN RAISE EXCEPTION 'waiver_invalid: full name required'; END IF;
  IF length(v_id) < 4 THEN RAISE EXCEPTION 'waiver_invalid: ID or passport number required'; END IF;
  BEGIN
    v_dob := (p_payload->>'date_of_birth')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'waiver_invalid: date of birth required';
  END;
  IF v_dob IS NULL OR v_dob > v_today OR v_dob <= DATE '1900-01-01' THEN RAISE EXCEPTION 'waiver_invalid: date of birth is not valid'; END IF;
  IF NOT COALESCE((p_payload->>'popia_consent')::boolean, false) THEN RAISE EXCEPTION 'waiver_invalid: consent to keep these details is required'; END IF;

  SELECT COALESCE(array_agg(DISTINCT c), '{}') INTO v_conditions
  FROM jsonb_array_elements_text(COALESCE(p_payload->'conditions', '[]'::jsonb)) c;
  IF EXISTS (SELECT 1 FROM unnest(v_conditions) c WHERE NOT (c = ANY (v_allowed))) THEN
    RAISE EXCEPTION 'waiver_invalid: unknown condition';
  END IF;
  IF v_drugs AND length(btrim(COALESCE(p_payload->'drugs'->>'details', ''))) < 2 THEN RAISE EXCEPTION 'waiver_invalid: say what drugs and when'; END IF;
  IF v_meds AND length(btrim(COALESCE(p_payload->'medication'->>'details', ''))) < 2 THEN RAISE EXCEPTION 'waiver_invalid: say which medicine'; END IF;
  IF cardinality(v_conditions) > 0 AND length(btrim(COALESCE(p_payload->>'condition_details', ''))) < 2 THEN
    RAISE EXCEPTION 'waiver_invalid: give details of the conditions ticked';
  END IF;
  IF v_staff_signs AND length(btrim(COALESCE(p_payload->>'staff_details', ''))) < 2 THEN
    RAISE EXCEPTION 'waiver_invalid: staff must note the signs of intoxication or concern';
  END IF;
  IF length(btrim(COALESCE(p_payload#>>'{emergency,name}', ''))) < 2 OR length(btrim(COALESCE(p_payload#>>'{emergency,phone}', ''))) < 7 THEN
    RAISE EXCEPTION 'waiver_invalid: emergency contact name and number required';
  END IF;

  v_age := date_part('year', age(v_today, v_dob))::integer;
  IF v_age < 18 THEN v_decline := array_append(v_decline, 'under_18'); END IF;
  IF v_influence THEN v_decline := array_append(v_decline, 'under_the_influence'); END IF;
  IF 'pregnant' = ANY (v_conditions) THEN v_decline := array_append(v_decline, 'pregnant_or_breastfeeding'); END IF;
  IF v_staff_signs THEN v_decline := array_append(v_decline, 'staff_concern'); END IF;
  v_status := CASE WHEN cardinality(v_decline) = 0 THEN 'valid' ELSE 'declined' END;

  IF v_status = 'valid' THEN
    IF NOT COALESCE((p_payload->>'age_confirmed')::boolean, false) THEN RAISE EXCEPTION 'waiver_invalid: age confirmation required'; END IF;
    IF v_signature IS NULL THEN RAISE EXCEPTION 'waiver_invalid: customer signature required'; END IF;
    IF v_signature !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' OR length(v_signature) > 200000 THEN RAISE EXCEPTION 'waiver_invalid: signature is not valid'; END IF;
  END IF;
  v_flagged := v_alcohol OR v_drugs OR v_meds OR cardinality(v_conditions) > 0;

  v_screening := jsonb_build_object(
    'alcohol', jsonb_build_object('had', v_alcohol, 'hours_ago', p_payload->'alcohol'->'hours_ago'),
    'drugs', jsonb_build_object('had', v_drugs, 'details', NULLIF(btrim(COALESCE(p_payload->'drugs'->>'details', '')), '')),
    'medication', jsonb_build_object('had', v_meds, 'details', NULLIF(btrim(COALESCE(p_payload->'medication'->>'details', '')), '')),
    'under_influence', v_influence,
    'conditions', to_jsonb(v_conditions),
    'condition_details', NULLIF(btrim(COALESCE(p_payload->>'condition_details', '')), ''));

  SELECT COALESCE(NULLIF(btrim(COALESCE(pr.full_name, '')), ''), 'Staff') INTO v_staff_name
  FROM (SELECT 1) x LEFT JOIN public.profiles pr ON pr.id = p_actor;

  INSERT INTO public.dab_waivers (
    status, decline_reasons, flagged, customer_name, date_of_birth, id_number, age_confirmed, popia_consent, screening,
    emergency_name, emergency_relationship, emergency_phone, emergency_alt_phone, signature,
    staff_id, staff_name, staff_noted_signs, staff_details)
  VALUES (
    v_status, v_decline, v_flagged, v_name, v_dob, v_id, COALESCE((p_payload->>'age_confirmed')::boolean, false), true, v_screening,
    btrim(p_payload#>>'{emergency,name}'), NULLIF(btrim(COALESCE(p_payload#>>'{emergency,relationship}', '')), ''),
    btrim(p_payload#>>'{emergency,phone}'), NULLIF(btrim(COALESCE(p_payload#>>'{emergency,alt_phone}', '')), ''),
    CASE WHEN v_status = 'valid' THEN v_signature ELSE NULL END,
    p_actor, v_staff_name, v_staff_signs, NULLIF(btrim(COALESCE(p_payload->>'staff_details', '')), ''))
  RETURNING id INTO v_id_new;

  PERFORM public._audit(p_actor, CASE WHEN v_status = 'valid' THEN 'dab_waiver_signed' ELSE 'dab_waiver_declined' END,
    'dab_waiver', v_id_new, jsonb_build_object('status', v_status, 'reasons', to_jsonb(v_decline), 'flagged', v_flagged));
  RETURN jsonb_build_object('id', v_id_new, 'status', v_status, 'decline_reasons', to_jsonb(v_decline), 'flagged', v_flagged);
END;
$fn$;

-- Use at the till: claim for one sale, release if the sale fails, link once it is done ---------------------------------
CREATE OR REPLACE FUNCTION public.dab_waiver_claim(p_actor uuid, p_waiver_id uuid, p_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_w public.dab_waivers;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF p_key IS NULL OR length(p_key) < 8 THEN RAISE EXCEPTION 'waiver_invalid: sale key required'; END IF;
  SELECT * INTO v_w FROM public.dab_waivers WHERE id = p_waiver_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_invalid: waiver not found'; END IF;
  IF v_w.status <> 'valid' THEN RAISE EXCEPTION 'waiver_invalid: this waiver was declined and cannot be used'; END IF;
  IF (v_w.signed_at AT TIME ZONE 'Africa/Johannesburg')::date <> (now() AT TIME ZONE 'Africa/Johannesburg')::date THEN
    RAISE EXCEPTION 'waiver_invalid: this waiver was signed on another day, a new one is needed';
  END IF;
  IF v_w.sale_id IS NOT NULL OR (v_w.claimed_at IS NOT NULL AND v_w.claim_key IS DISTINCT FROM p_key) THEN
    RAISE EXCEPTION 'waiver_invalid: this waiver has already been used for a sale';
  END IF;
  UPDATE public.dab_waivers SET claimed_at = COALESCE(claimed_at, now()), claim_key = p_key WHERE id = p_waiver_id;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.dab_waiver_release(p_actor uuid, p_waiver_id uuid, p_key text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  UPDATE public.dab_waivers SET claimed_at = NULL, claim_key = NULL
  WHERE id = p_waiver_id AND claim_key = p_key AND sale_id IS NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.dab_waiver_link_sale(p_actor uuid, p_waiver_id uuid, p_key text, p_sale_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  UPDATE public.dab_waivers SET sale_id = p_sale_id
  WHERE id = p_waiver_id AND claim_key = p_key AND (sale_id IS NULL OR sale_id = p_sale_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_invalid: waiver was not claimed for this sale'; END IF;
  PERFORM public._audit(p_actor, 'dab_waiver_used', 'dab_waiver', p_waiver_id, jsonb_build_object('sale_id', p_sale_id));
END;
$fn$;

-- Read (managers and admins only) ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dab_waiver_get(p_actor uuid, p_waiver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_w public.dab_waivers;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  SELECT * INTO v_w FROM public.dab_waivers WHERE id = p_waiver_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_invalid: waiver not found'; END IF;
  PERFORM public._audit(p_actor, 'dab_waiver_viewed', 'dab_waiver', p_waiver_id, '{}'::jsonb);
  RETURN jsonb_build_object(
    'id', v_w.id, 'status', v_w.status, 'decline_reasons', to_jsonb(v_w.decline_reasons), 'flagged', v_w.flagged,
    'signed_at', v_w.signed_at, 'retain_until', v_w.retain_until,
    'customer_name', v_w.customer_name, 'date_of_birth', v_w.date_of_birth, 'id_number', v_w.id_number,
    'age_confirmed', v_w.age_confirmed, 'screening', v_w.screening,
    'emergency', jsonb_build_object('name', v_w.emergency_name, 'relationship', v_w.emergency_relationship,
                                    'phone', v_w.emergency_phone, 'alt_phone', v_w.emergency_alt_phone),
    'signature', v_w.signature, 'staff_name', v_w.staff_name, 'staff_noted_signs', v_w.staff_noted_signs,
    'staff_details', v_w.staff_details, 'sale_id', v_w.sale_id,
    'receipt_number', (SELECT s.receipt_number FROM public.pos_sales s WHERE s.id = v_w.sale_id),
    'incident', v_w.incident);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.dab_waiver_list(p_actor uuid, p_limit integer DEFAULT 50, p_before timestamptz DEFAULT NULL, p_search text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  RETURN COALESCE((
    SELECT jsonb_agg(r ORDER BY (r->>'signed_at') DESC) FROM (
      SELECT jsonb_build_object(
        'id', w.id, 'signed_at', w.signed_at, 'customer_name', w.customer_name, 'status', w.status,
        'decline_reasons', to_jsonb(w.decline_reasons), 'flagged', w.flagged, 'staff_name', w.staff_name,
        'used', w.sale_id IS NOT NULL, 'has_incident', w.incident IS NOT NULL) AS r
      FROM public.dab_waivers w
      WHERE (p_before IS NULL OR w.signed_at < p_before)
        AND (p_search IS NULL OR btrim(p_search) = '' OR w.customer_name ILIKE '%' || replace(replace(btrim(p_search), '%', ''), '_', '') || '%')
      ORDER BY w.signed_at DESC
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)) q), '[]'::jsonb);
END;
$fn$;

-- Incident record (Section 7), any staff, within 24 hours of signing -------------------------------------------------
CREATE OR REPLACE FUNCTION public.dab_waiver_record_incident(
  p_actor uuid, p_waiver_id uuid, p_text text, p_emergency_services boolean, p_emergency_contact boolean,
  p_incident_time text, p_notes text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_w public.dab_waivers;
  v_role public.app_role;
BEGIN
  v_role := public._assert_staff(p_actor, 'budtender');
  IF length(btrim(COALESCE(p_text, ''))) < 3 OR length(p_text) > 1000 THEN RAISE EXCEPTION 'waiver_invalid: say briefly what happened'; END IF;
  IF p_notes IS NOT NULL AND length(p_notes) > 1000 THEN RAISE EXCEPTION 'waiver_invalid: notes are too long'; END IF;
  IF p_incident_time IS NOT NULL AND length(p_incident_time) > 20 THEN RAISE EXCEPTION 'waiver_invalid: time is not valid'; END IF;
  SELECT * INTO v_w FROM public.dab_waivers WHERE id = p_waiver_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'waiver_invalid: waiver not found'; END IF;
  IF v_w.signed_at < now() - interval '24 hours' AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'forbidden: only a manager can add to a waiver after 24 hours' USING ERRCODE = '42501';
  END IF;
  UPDATE public.dab_waivers SET incident = jsonb_build_object(
    'text', btrim(p_text), 'emergency_services', COALESCE(p_emergency_services, false),
    'emergency_contact', COALESCE(p_emergency_contact, false), 'time', NULLIF(btrim(COALESCE(p_incident_time, '')), ''),
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''), 'recorded_by', p_actor, 'recorded_at', now())
  WHERE id = p_waiver_id;
  PERFORM public._audit(p_actor, 'dab_waiver_incident', 'dab_waiver', p_waiver_id,
    jsonb_build_object('emergency_services', COALESCE(p_emergency_services, false), 'emergency_contact', COALESCE(p_emergency_contact, false)));
END;
$fn$;

-- Retention: delete 3 years after signing ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dab_waiver_purge_expired()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.dab_waivers WHERE retain_until < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

DO $mig$
DECLARE
  v_sig text;
BEGIN
  FOR v_sig IN SELECT unnest(ARRAY[
    'public.dab_waiver_create(uuid, jsonb)',
    'public.dab_waiver_claim(uuid, uuid, text)',
    'public.dab_waiver_release(uuid, uuid, text)',
    'public.dab_waiver_link_sale(uuid, uuid, text, uuid)',
    'public.dab_waiver_get(uuid, uuid)',
    'public.dab_waiver_list(uuid, integer, timestamptz, text)',
    'public.dab_waiver_record_incident(uuid, uuid, text, boolean, boolean, text, text)',
    'public.dab_waiver_purge_expired()'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_sig);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('dab-waiver-retention', '15 0 * * *', 'SELECT public.dab_waiver_purge_expired()');
  END IF;
END
$mig$;
