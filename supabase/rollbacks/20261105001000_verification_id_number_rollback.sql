-- Rollback for 20261105001000_verification_id_number: removes the function that records the ID / passport number at
-- the verification step. Numbers already stored stay in member_signup_details. Roll the app back first (the
-- verification step calls this function), or sign-up must ask for the number again.
DROP FUNCTION IF EXISTS public.verification_record_id_number(uuid, text, date, text);
