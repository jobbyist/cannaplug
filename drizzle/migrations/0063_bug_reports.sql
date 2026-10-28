-- 29 Oct 2026: "Report a bug" form. A visitor (signed in or not) sends feedback, a bug or an idea from the header menu.
--   * bug_reports keeps what was sent (type, message, optional name and email, the page address without its query, the
--     browser) so nothing is lost if an email fails. RLS is on and browsers have no access; only the server reads it.
--   * bug_report_submit stores the report and queues one staff email per recipient (the recipients are fixed in the
--     server code, not chosen by the visitor). It is idempotent on a key (a double click sends once) and rate-limited
--     to 5 reports an hour per hashed IP address.
-- No health, ID or account data is collected. No DROP and no DELETE in this file.

CREATE TABLE IF NOT EXISTS public.bug_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('bug', 'feedback', 'idea')),
  name text CHECK (name IS NULL OR length(name) <= 120),
  email text CHECK (email IS NULL OR (length(email) <= 254 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  message text NOT NULL CHECK (length(message) BETWEEN 10 AND 4000),
  page text CHECK (page IS NULL OR length(page) <= 300),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  ip_hash text,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 120)
);
CREATE INDEX IF NOT EXISTS bug_reports_ip_recent_idx ON public.bug_reports (ip_hash, created_at DESC);
ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bug_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bug_reports TO service_role;

CREATE OR REPLACE FUNCTION public.bug_report_submit(
  p_name text, p_email text, p_kind text, p_message text, p_page text, p_agent text,
  p_ip_hash text, p_inboxes text[], p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_recent integer;
  v_inbox text;
  v_name text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_email text := NULLIF(btrim(COALESCE(p_email, '')), '');
  v_msg text := btrim(COALESCE(p_message, ''));
  v_data jsonb;
BEGIN
  IF p_kind NOT IN ('bug', 'feedback', 'idea') THEN RAISE EXCEPTION 'invalid_input: unknown type'; END IF;
  IF length(v_msg) NOT BETWEEN 10 AND 4000 THEN
    RAISE EXCEPTION 'invalid_input: the message must be 10 to 4000 characters';
  END IF;
  IF v_email IS NOT NULL AND (length(v_email) > 254 OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$') THEN
    RAISE EXCEPTION 'invalid_input: that email address does not look right';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 120 THEN
    RAISE EXCEPTION 'invalid_input: missing request key';
  END IF;
  IF p_inboxes IS NULL OR cardinality(p_inboxes) NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'invalid_inbox'; END IF;
  FOREACH v_inbox IN ARRAY p_inboxes LOOP
    IF v_inbox !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'invalid_inbox'; END IF;
  END LOOP;

  -- The same request twice (a double click or a retry) is answered, not stored again.
  SELECT b.id INTO v_id FROM public.bug_reports b WHERE b.idempotency_key = p_idempotency_key;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('id', v_id, 'replayed', true); END IF;

  IF p_ip_hash IS NOT NULL THEN
    SELECT count(*) INTO v_recent FROM public.bug_reports
    WHERE ip_hash = p_ip_hash AND created_at > now() - interval '1 hour';
    IF v_recent >= 5 THEN RAISE EXCEPTION 'rate_limited: too many reports, please try again later'; END IF;
  END IF;

  INSERT INTO public.bug_reports (kind, name, email, message, page, user_agent, ip_hash, idempotency_key)
  VALUES (p_kind, left(v_name, 120), v_email, v_msg, left(NULLIF(btrim(COALESCE(p_page, '')), ''), 300),
          left(NULLIF(btrim(COALESCE(p_agent, '')), ''), 300), p_ip_hash, p_idempotency_key)
  RETURNING id INTO v_id;

  v_data := jsonb_build_object('report_id', v_id, 'kind', p_kind, 'name', left(v_name, 120), 'email', v_email,
                               'message', v_msg, 'page', left(NULLIF(btrim(COALESCE(p_page, '')), ''), 300),
                               'user_agent', left(NULLIF(btrim(COALESCE(p_agent, '')), ''), 300));
  FOREACH v_inbox IN ARRAY p_inboxes LOOP
    PERFORM public.notification_enqueue('email', 'bug_report_staff', v_inbox, NULL, 'staff', v_data,
                                        'bugreport:' || v_id::text || ':' || md5(lower(v_inbox)));
  END LOOP;
  PERFORM public._audit(NULL, 'bug_report_submitted', 'bug_report', v_id, jsonb_build_object('kind', p_kind));
  RETURN jsonb_build_object('id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.bug_report_submit(text, text, text, text, text, text, text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bug_report_submit(text, text, text, text, text, text, text, text[], text) TO service_role;
