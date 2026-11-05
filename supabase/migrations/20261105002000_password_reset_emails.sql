-- 5 Nov 2026: branded password-reset emails sent by the app through Resend (owner request), instead of Supabase's
-- built-in mailer (a few emails an hour, unbranded, often in spam). The app asks Supabase for the one-time reset
-- link (auth.admin.generateLink) and emails it itself from the verified CannaPlug sender.
--
--   * password_reset_requests   one row per reset email we decided to send. Only a hash of the email address is
--     kept (never the address), plus the hashed IP for self-service requests and the staff member for staff-sent
--     ones. RLS on, no browser access.
--   * password_reset_begin(email, ip_hash, actor, key)   service role only. Decides whether a reset email may go
--     out: at most 3 an hour per email address, 10 an hour per connection (self-service only), and only while
--     Resend's daily allowance has room (resets may use the 5 emails kept back for them). A staff request
--     (actor given) must come from a manager or admin. Allowed requests are recorded and audited (no address).
--   * password_reset_finish(request, status)   records whether the email was sent, there was no account, or it
--     failed. Only 'sent' counts against the daily allowance.
--   * _emails_sent_24h() now also counts reset emails, so the rest of the email budget stays accurate.

CREATE TABLE IF NOT EXISTS public.password_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text CHECK (ip_hash IS NULL OR length(ip_hash) BETWEEN 8 AND 128),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'sent', 'no_account', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS password_reset_requests_email_idx
  ON public.password_reset_requests (email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS password_reset_requests_ip_idx
  ON public.password_reset_requests (ip_hash, created_at DESC) WHERE ip_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS password_reset_requests_sent_idx
  ON public.password_reset_requests (created_at DESC) WHERE status = 'sent';
ALTER TABLE public.password_reset_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.password_reset_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.password_reset_requests TO service_role;

CREATE OR REPLACE FUNCTION public._password_reset_email_hash(p_email text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT encode(sha256(convert_to('cannaplug-reset:' || lower(btrim(COALESCE(p_email, ''))), 'utf8')), 'hex');
$$;
REVOKE ALL ON FUNCTION public._password_reset_email_hash(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._password_reset_email_hash(text) TO service_role;

CREATE OR REPLACE FUNCTION public._emails_sent_24h()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT ((SELECT count(*) FROM public.notification_events
           WHERE channel = 'email' AND status = 'sent' AND sent_at > now() - interval '24 hours')
        + (SELECT count(*) FROM public.notification_events
           WHERE channel = 'email' AND status = 'sending' AND locked_until > now())
        + (SELECT count(*) FROM public.pos_receipt_sends WHERE created_at > now() - interval '24 hours')
        + (SELECT count(*) FROM public.password_reset_requests
           WHERE status IN ('sent', 'allowed') AND created_at > now() - interval '24 hours'))::integer;
$$;
REVOKE ALL ON FUNCTION public._emails_sent_24h() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._emails_sent_24h() TO service_role;

CREATE OR REPLACE FUNCTION public.password_reset_begin(
  p_email text,
  p_ip_hash text,
  p_actor uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_per_email constant integer := 3;
  c_per_ip constant integer := 10;
  v_hash text := public._password_reset_email_hash(p_email);
  v_idem_actor uuid := COALESCE(p_actor, '00000000-0000-0000-0000-000000000000'::uuid);
  v_cached jsonb;
  v_limit integer;
  v_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_email IS NULL OR btrim(p_email) !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(p_email) > 254 THEN
    RAISE EXCEPTION 'invalid_input: enter a valid email address';
  END IF;
  IF p_actor IS NOT NULL THEN
    PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  END IF;
  -- The request hash is the hashed address, never the address itself.
  v_cached := public._idem_begin('pw_reset', v_idem_actor, p_idempotency_key,
                                 jsonb_build_object('email', v_hash, 'staff', p_actor IS NOT NULL));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- One decision at a time, so two requests cannot both take the last allowed slot.
  SELECT s.daily_limit INTO v_limit FROM public.email_budget_settings s WHERE s.id FOR UPDATE;

  IF (SELECT count(*) FROM public.password_reset_requests r
      WHERE r.email_hash = v_hash AND r.created_at > now() - interval '1 hour') >= c_per_email THEN
    v_response := jsonb_build_object('allowed', false, 'reason', 'email_limit');
  ELSIF p_actor IS NULL AND p_ip_hash IS NOT NULL AND
        (SELECT count(*) FROM public.password_reset_requests r
         WHERE r.ip_hash = p_ip_hash AND r.created_at > now() - interval '1 hour') >= c_per_ip THEN
    v_response := jsonb_build_object('allowed', false, 'reason', 'ip_limit');
  ELSIF public._emails_sent_24h() >= COALESCE(v_limit, 100) THEN
    v_response := jsonb_build_object('allowed', false, 'reason', 'daily_limit');
  ELSE
    INSERT INTO public.password_reset_requests (email_hash, ip_hash, requested_by)
    VALUES (v_hash, CASE WHEN p_actor IS NULL THEN p_ip_hash END, p_actor)
    RETURNING id INTO v_id;
    INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (p_actor, 'password_reset_requested', 'password_reset_request', v_id,
            jsonb_build_object('by_staff', p_actor IS NOT NULL));
    v_response := jsonb_build_object('allowed', true, 'request_id', v_id);
  END IF;

  RETURN public._idem_finish('pw_reset', v_idem_actor, p_idempotency_key, v_response);
END;
$$;
REVOKE ALL ON FUNCTION public.password_reset_begin(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.password_reset_begin(text, text, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.password_reset_finish(p_request_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent', 'no_account', 'failed') THEN
    RAISE EXCEPTION 'invalid_input: unknown reset status';
  END IF;
  -- Only an open request can be finished, and only once.
  UPDATE public.password_reset_requests
  SET status = p_status, finished_at = now()
  WHERE id = p_request_id AND status = 'allowed';
END;
$$;
REVOKE ALL ON FUNCTION public.password_reset_finish(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.password_reset_finish(uuid, text) TO service_role;
