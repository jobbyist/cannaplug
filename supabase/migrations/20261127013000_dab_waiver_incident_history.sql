-- 27 Nov 2026: recording an incident again on a waiver no longer overwrites the earlier record; the earlier one is kept in incident.previous.
-- Rollback: supabase/rollbacks/20261127013000_dab_waiver_incident_history_rollback.sql (back to 20261127012000).

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
  -- An update never destroys the earlier record: the one it replaces moves into "previous" (oldest first).
  UPDATE public.dab_waivers SET incident = jsonb_build_object(
    'text', btrim(p_text), 'emergency_services', COALESCE(p_emergency_services, false),
    'emergency_contact', COALESCE(p_emergency_contact, false), 'time', NULLIF(btrim(COALESCE(p_incident_time, '')), ''),
    'notes', NULLIF(btrim(COALESCE(p_notes, '')), ''), 'recorded_by', p_actor, 'recorded_at', now(),
    'previous', CASE WHEN v_w.incident IS NULL THEN '[]'::jsonb
                     ELSE COALESCE(v_w.incident->'previous', '[]'::jsonb) || jsonb_build_array(v_w.incident - 'previous') END)
  WHERE id = p_waiver_id;
  PERFORM public._audit(p_actor, 'dab_waiver_incident', 'dab_waiver', p_waiver_id,
    jsonb_build_object('emergency_services', COALESCE(p_emergency_services, false), 'emergency_contact', COALESCE(p_emergency_contact, false)));
END;
$fn$;
