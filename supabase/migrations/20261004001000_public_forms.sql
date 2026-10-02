-- Milestone 6: public website forms (contact + newsletter) deliver to the staff inbox through the notification queue.
--
--   * contact_submissions     every contact-form message is stored (the inbox email is a convenience copy)
--   * newsletter_subscribers  explicit, timestamped consent; one row per address; unsubscribe by secret token
--   * contact_submit / newsletter_subscribe / newsletter_unsubscribe   service-role RPCs with per-IP rate limits.
--     Nothing is emailed from the request itself: they enqueue rows that the dispatcher sends.

CREATE TABLE public.contact_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 2 AND 200),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 5 AND 4000),
  ip_hash text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled', 'spam')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_submissions_ip_idx ON public.contact_submissions (ip_hash, created_at DESC);

CREATE TABLE public.newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254),
  consent_at timestamptz NOT NULL DEFAULT now(),
  consent_source text NOT NULL DEFAULT 'website_footer',
  ip_hash text,
  unsubscribe_token text NOT NULL DEFAULT substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48),
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX newsletter_subscribers_email_uq ON public.newsletter_subscribers (lower(email));
CREATE UNIQUE INDEX newsletter_subscribers_token_uq ON public.newsletter_subscribers (unsubscribe_token);

ALTER TABLE public.contact_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_submissions, public.newsletter_subscribers FROM anon, authenticated;
GRANT ALL ON public.contact_submissions, public.newsletter_subscribers TO service_role;

-- p_inbox is the staff address that receives the message (server config, default info@cannaplug012.co.za).
CREATE OR REPLACE FUNCTION public.contact_submit(
  p_name text, p_email text, p_subject text, p_message text, p_ip_hash text, p_inbox text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_recent integer;
  v_data jsonb;
BEGIN
  IF p_inbox IS NULL OR p_inbox !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'invalid_inbox'; END IF;
  IF p_ip_hash IS NOT NULL THEN
    SELECT count(*) INTO v_recent FROM public.contact_submissions
    WHERE ip_hash = p_ip_hash AND created_at > now() - interval '1 hour';
    IF v_recent >= 5 THEN RAISE EXCEPTION 'rate_limited: too many messages, please try again later'; END IF;
  END IF;
  INSERT INTO public.contact_submissions (name, email, subject, message, ip_hash)
  VALUES (btrim(p_name), btrim(p_email), btrim(p_subject), btrim(p_message), p_ip_hash)
  RETURNING id INTO v_id;
  v_data := jsonb_build_object('submission_id', v_id, 'name', btrim(p_name), 'email', btrim(p_email),
                               'subject', btrim(p_subject), 'message', btrim(p_message));
  -- to the team (reply-to is the sender, set by the template data) and an acknowledgement to the sender
  PERFORM public.notification_enqueue('email', 'contact_form_staff', p_inbox, NULL, 'staff', v_data, 'contact:' || v_id::text || ':staff');
  PERFORM public.notification_enqueue('email', 'contact_form_ack', btrim(p_email), NULL, 'transactional', v_data, 'contact:' || v_id::text || ':ack');
  RETURN jsonb_build_object('id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.newsletter_subscribe(p_email text, p_ip_hash text, p_source text DEFAULT 'website_footer')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_row public.newsletter_subscribers;
  v_recent integer;
  v_email text := btrim(p_email);
BEGIN
  IF v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN RAISE EXCEPTION 'invalid_email'; END IF;
  IF p_ip_hash IS NOT NULL THEN
    SELECT count(*) INTO v_recent FROM public.newsletter_subscribers
    WHERE ip_hash = p_ip_hash AND created_at > now() - interval '1 hour';
    IF v_recent >= 10 THEN RAISE EXCEPTION 'rate_limited: too many sign-ups, please try again later'; END IF;
  END IF;
  INSERT INTO public.newsletter_subscribers (email, consent_source, ip_hash)
  VALUES (v_email, left(COALESCE(p_source, 'website_footer'), 60), p_ip_hash)
  ON CONFLICT (lower(email)) DO UPDATE
    SET unsubscribed_at = NULL, consent_at = now(), consent_source = EXCLUDED.consent_source
    WHERE public.newsletter_subscribers.unsubscribed_at IS NOT NULL
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN
    -- already subscribed: answer the same way (no enumeration), send nothing new
    RETURN jsonb_build_object('status', 'subscribed');
  END IF;
  PERFORM public.notification_enqueue('email', 'newsletter_welcome', v_row.email, NULL, 'transactional',
    jsonb_build_object('unsubscribe_token', v_row.unsubscribe_token), 'newsletter:' || v_row.id::text || ':' || extract(epoch FROM v_row.consent_at)::bigint::text);
  RETURN jsonb_build_object('status', 'subscribed');
END;
$$;

CREATE OR REPLACE FUNCTION public.newsletter_unsubscribe(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{48}$' THEN RAISE EXCEPTION 'invalid_token'; END IF;
  UPDATE public.newsletter_subscribers SET unsubscribed_at = now() WHERE unsubscribe_token = p_token AND unsubscribed_at IS NULL;
  RETURN jsonb_build_object('status', 'unsubscribed');
END;
$$;

REVOKE ALL ON FUNCTION public.contact_submit(text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.newsletter_subscribe(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.newsletter_unsubscribe(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contact_submit(text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.newsletter_subscribe(text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.newsletter_unsubscribe(text) TO service_role;
