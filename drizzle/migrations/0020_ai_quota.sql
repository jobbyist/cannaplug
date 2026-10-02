-- Milestone 6: fixed-window usage counters so the AI features stay inside the Gemini free tier and cannot be
-- abused. One row per (bucket); the bucket name carries the window (e.g. gemini:rpm:<minute>), so there is
-- no read-modify-write race: ai_quota_take increments only while the count is below the limit.

CREATE TABLE public.ai_usage_counters (
  bucket text PRIMARY KEY CHECK (length(bucket) BETWEEN 3 AND 200),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_counters_expiry_idx ON public.ai_usage_counters (expires_at);
ALTER TABLE public.ai_usage_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_usage_counters FROM anon, authenticated;
GRANT ALL ON public.ai_usage_counters TO service_role;

-- Returns true and counts the call, or false (and counts nothing) once p_limit calls were already taken.
CREATE OR REPLACE FUNCTION public.ai_quota_take(p_bucket text, p_limit integer, p_ttl_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 10 AND 172800 THEN
    RAISE EXCEPTION 'invalid_quota_arguments';
  END IF;
  INSERT INTO public.ai_usage_counters AS t (bucket, count, expires_at)
  VALUES (p_bucket, 1, now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (bucket) DO UPDATE SET count = t.count + 1, updated_at = now()
  WHERE t.count < p_limit
  RETURNING t.count INTO v_count;
  RETURN v_count IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.ai_quota_purge()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.ai_usage_counters WHERE expires_at < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_quota_take(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_quota_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_quota_take(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_quota_purge() TO service_role;
