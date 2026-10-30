-- Rollback for 20261031004000_ask_the_plug_matching: removes the stock reader, the safety-buffer settings, the match
-- log and the recount-alert hook. Refused while any product is flagged "needs a practitioner recommendation": those
-- flags are owner decisions and dropping the column would silently make those products recommendable again.
-- Unflag them (or accept losing the flags by clearing them) first. Staff recount alerts already raised are kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.products WHERE requires_recommendation) THEN
    RAISE EXCEPTION 'rollback refused: products are flagged requires_recommendation; clear the flags first';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.plug_match_log(text, text, jsonb, uuid[]);
DROP FUNCTION IF EXISTS public.plug_settings_set(uuid, integer, integer, integer, text);
DROP FUNCTION IF EXISTS public.plug_match_candidates(text[]);
DROP FUNCTION IF EXISTS public._plug_units_7d();
DROP TABLE IF EXISTS public.plug_match_events;
DROP TABLE IF EXISTS public.plug_settings;
ALTER TABLE public.products DROP COLUMN IF EXISTS requires_recommendation;
