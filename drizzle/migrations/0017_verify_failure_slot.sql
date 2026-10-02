-- Atomic failure limiting for public verification.
--
-- The failure limiter used to READ a counter (document_verify_blocked) before the lookup and INCREMENT it
-- afterwards, so a burst of parallel guesses could all read "not blocked" before any of them counted. The
-- verifier now RESERVES a failure slot first (document_verify_rate_check is a single atomic upsert, so every
-- concurrent request gets a distinct count and anything over the limit is refused), looks the token up, and
-- gives the slot back with document_verify_refund when the token turned out to be a real document. Unknown and
-- malformed tokens keep their slot. document_verify_blocked is no longer used by the application.

CREATE FUNCTION public.document_verify_refund(p_bucket text, p_window_seconds integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  UPDATE public.document_verify_attempts SET attempts = GREATEST(attempts - 1, 0)
  WHERE bucket = left(p_bucket, 100)
    AND window_start = to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
$$;
REVOKE ALL ON FUNCTION public.document_verify_refund(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_verify_refund(text, integer) TO service_role;
