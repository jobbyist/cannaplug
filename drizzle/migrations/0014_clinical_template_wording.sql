-- Real wording for the two seeded templates, plus the placeholders and rules that wording needs.
--
--   * New whitelisted placeholders: document.verification_url, prescription.issue_date and the two
--     "late-bound" signature placeholders (signature.status, signature.signed_at). Late-bound means the value
--     does not exist when the text is frozen and hashed, so the frozen text keeps the token and the PDF
--     renderer fills it (PENDING before signing, the signature facts after).
--   * A medical letter no longer has to contain a per-document {{clinical.*}} field: the practitioner-approved
--     wording can be entirely fixed. (The letter cannot contain prescription fields, and vice versa.)
--   * A prescription template no longer has to print the expiry date in its body; the document still requires
--     the practitioner's expiry date and the PDF header prints it.
--   * The seeds are updated in place: they are still DRAFT and were never active, so this does not mutate any
--     active or historical version. They are NOT activated: a practitioner must submit/approve them in the app.
--     The placeholder marker is removed because this is the supplied wording; the marker still blocks any
--     other template that carries it.

CREATE OR REPLACE FUNCTION public._template_allowed_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT ARRAY[
  'doctor.title', 'doctor.full_name', 'doctor.hpcsa_number', 'doctor.practice_number', 'doctor.qualification',
  'doctor.speciality', 'doctor.practice_name', 'doctor.practice_address', 'doctor.practice_phone',
  'doctor.practice_email',
  'member.full_name', 'member.member_id', 'member.date_of_birth',
  'document.issue_date', 'document.expiry_date', 'document.document_id', 'document.verification_url',
  'signature.status', 'signature.signed_at',
  'prescription.medicine_name', 'prescription.generic_name', 'prescription.dosage_form',
  'prescription.strength', 'prescription.quantity_numeric', 'prescription.quantity_words',
  'prescription.directions', 'prescription.route', 'prescription.frequency', 'prescription.duration',
  'prescription.repeats', 'prescription.indication', 'prescription.special_instructions',
  'prescription.issue_date',
  'clinical.statement', 'clinical.indication_summary', 'clinical.treatment_summary'
] $$;

CREATE OR REPLACE FUNCTION public._template_validate(p_type text, p_content text, p_schema jsonb)
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
    -- A letter may be entirely practitioner-approved fixed wording: no per-document clinical field is required.
  ELSE
    IF EXISTS (SELECT 1 FROM unnest(v_found) k WHERE k LIKE 'clinical.%') THEN
      RAISE EXCEPTION 'template_invalid: a prescription template cannot contain clinical.* letter fields';
    END IF;
    FOREACH v_k IN ARRAY public._rx_required_keys() LOOP
      IF NOT (('prescription.' || v_k) = ANY (v_found)) THEN
        RAISE EXCEPTION 'template_invalid: a prescription template must contain {{prescription.%}}', v_k;
      END IF;
    END LOOP;
    -- The expiry date is still required on the document itself (and printed by the PDF header).
  END IF;
  IF NOT ('doctor.full_name' = ANY (v_found)) OR NOT ('doctor.hpcsa_number' = ANY (v_found))
     OR NOT ('document.document_id' = ANY (v_found)) OR NOT ('member.full_name' = ANY (v_found)) THEN
    RAISE EXCEPTION 'template_invalid: templates must show the practitioner name, registration number, document id and member name';
  END IF;
END;
$$;


UPDATE public.document_templates SET
  template_content = $tpl$CANNAPLUG

MEDICAL PRACTITIONER LETTER

Document ID: {{document.document_id}}
Date of Issue: {{document.issue_date}}

To Whom It May Concern

I, {{doctor.full_name}}, {{doctor.qualification}}, HPCSA Registration No. {{doctor.hpcsa_number}}, practising at {{doctor.practice_name}}, confirm that I have assessed:

Patient/Member: {{member.full_name}}
Member Reference: {{member.member_id}}
Date of Birth: {{member.date_of_birth}}

Following my professional assessment and clinical evaluation, I have considered the patient’s circumstances and medical requirements.

Where applicable, the patient’s treatment plan and any therapeutic use of medicines or scheduled substances are determined by me in my capacity as the treating/authorised medical practitioner and are subject to my ongoing clinical assessment.

This letter is issued for the purpose of confirming the above medical practitioner–patient relationship and the practitioner’s clinical assessment. It does not, by itself, constitute a prescription, dispensing authorization, or authorization to supply any medicine or scheduled substance unless expressly stated in a separate valid prescription/order issued by the authorised prescriber.

The patient remains subject to appropriate clinical follow-up, monitoring and review.

Should further clinical information be required, this should be requested from the undersigned with the patient’s appropriate consent and subject to applicable confidentiality and privacy requirements.

Practitioner

{{doctor.full_name}}
{{doctor.qualification}}
HPCSA Registration No.: {{doctor.hpcsa_number}}
Practice No.: {{doctor.practice_number}}
{{doctor.practice_name}}
{{doctor.practice_address}}
{{doctor.practice_phone}}
{{doctor.practice_email}}

Electronic Signature: {{signature.status}}

Document Verification: {{document.verification_url}}

This document is electronically issued and must be verified using the document verification mechanism provided by CannaPlug.$tpl$,
  template_schema = $sch${"placeholders": [{"key": "document.document_id", "required": true}, {"key": "document.issue_date", "required": true}, {"key": "doctor.full_name", "required": true}, {"key": "doctor.qualification", "required": true}, {"key": "doctor.hpcsa_number", "required": true}, {"key": "doctor.practice_name", "required": true}, {"key": "member.full_name", "required": true}, {"key": "member.member_id", "required": true}, {"key": "member.date_of_birth", "required": true}, {"key": "doctor.practice_number", "required": false}, {"key": "doctor.practice_address", "required": false}, {"key": "doctor.practice_phone", "required": false}, {"key": "doctor.practice_email", "required": false}, {"key": "signature.status", "required": false}, {"key": "document.verification_url", "required": true}]}$sch$::jsonb,
  change_note = 'Practitioner-supplied wording. Awaiting practitioner approval.'
WHERE document_type = 'MEDICAL_LETTER' AND name = 'Medical letter' AND version = 1 AND status = 'DRAFT' AND created_by IS NULL;

UPDATE public.document_templates SET
  template_content = $tpl$CANNAPLUG

PRESCRIPTION / MEDICINE ORDER

Document ID: {{document.document_id}}
Date of Issue: {{prescription.issue_date}}

PATIENT

Full Name: {{member.full_name}}
Member Reference: {{member.member_id}}
Date of Birth: {{member.date_of_birth}}

PRESCRIBER

Name: {{doctor.full_name}}
Qualification: {{doctor.qualification}}
HPCSA Registration No.: {{doctor.hpcsa_number}}
Practice No.: {{doctor.practice_number}}
Practice: {{doctor.practice_name}}

MEDICINE / SCHEDULED SUBSTANCE

Medicine / Approved Name: {{prescription.medicine_name}}

Generic Name: {{prescription.generic_name}}

Dosage Form: {{prescription.dosage_form}}

Strength: {{prescription.strength}}

Quantity: {{prescription.quantity_numeric}}
Quantity in Words: {{prescription.quantity_words}}

DIRECTIONS FOR USE

{{prescription.directions}}

Route of Administration: {{prescription.route}}

Frequency: {{prescription.frequency}}

Duration: {{prescription.duration}}

Repeats / Repeat Authorisation: {{prescription.repeats}}

CLINICAL INFORMATION

Indication / Clinical Notes, where required and appropriate:

{{prescription.indication}}

Additional Instructions:

{{prescription.special_instructions}}

PRESCRIBER DECLARATION

I confirm that I have personally assessed the patient identified in this prescription/order and that the medicine or scheduled substance specified above is being prescribed/ordered in accordance with my professional judgment and the applicable legal and professional requirements.

I confirm that the information contained in this prescription/order has been reviewed and authorised by me.

AUTHORISED PRESCRIBER

{{doctor.full_name}}

HPCSA Registration No.: {{doctor.hpcsa_number}}

Electronic Signature: {{signature.status}}

Signature Date: {{signature.signed_at}}

Document Verification: {{document.verification_url}}

Document ID: {{document.document_id}}

This document must be authenticated and verified in accordance with the applicable requirements before dispensing or supply.$tpl$,
  template_schema = $sch${"placeholders": [{"key": "document.document_id", "required": true}, {"key": "prescription.issue_date", "required": true, "clinical": true}, {"key": "member.full_name", "required": true}, {"key": "member.member_id", "required": true}, {"key": "member.date_of_birth", "required": true}, {"key": "doctor.full_name", "required": true}, {"key": "doctor.qualification", "required": true}, {"key": "doctor.hpcsa_number", "required": true}, {"key": "doctor.practice_number", "required": false}, {"key": "doctor.practice_name", "required": true}, {"key": "prescription.medicine_name", "required": true, "clinical": true}, {"key": "prescription.generic_name", "required": false, "clinical": true}, {"key": "prescription.dosage_form", "required": true, "clinical": true}, {"key": "prescription.strength", "required": true, "clinical": true}, {"key": "prescription.quantity_numeric", "required": true, "clinical": true}, {"key": "prescription.quantity_words", "required": true, "clinical": true}, {"key": "prescription.directions", "required": true, "clinical": true}, {"key": "prescription.route", "required": true, "clinical": true}, {"key": "prescription.frequency", "required": true, "clinical": true}, {"key": "prescription.duration", "required": true, "clinical": true}, {"key": "prescription.repeats", "required": true, "clinical": true}, {"key": "prescription.indication", "required": true, "clinical": true}, {"key": "prescription.special_instructions", "required": false, "clinical": true}, {"key": "signature.status", "required": false}, {"key": "signature.signed_at", "required": false}, {"key": "document.verification_url", "required": true}]}$sch$::jsonb,
  change_note = 'Practitioner-supplied wording. Awaiting practitioner/pharmacist approval.'
WHERE document_type = 'PRESCRIPTION_ORDER' AND name = 'Prescription order' AND version = 1 AND status = 'DRAFT' AND created_by IS NULL;

-- Both must now pass the structural validation they will face at submission.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT document_type, template_content, template_schema FROM public.document_templates
           WHERE created_by IS NULL AND version = 1 AND status = 'DRAFT' LOOP
    PERFORM public._template_validate(t.document_type, t.template_content, t.template_schema);
  END LOOP;
END
$$;
