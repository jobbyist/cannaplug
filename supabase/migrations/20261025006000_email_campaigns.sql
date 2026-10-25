-- 25 Oct 2026: marketing email campaigns + member email preferences.
--   * email_campaigns: drafts a manager writes in Admin -> Promotions (subject, headline, body, optional button).
--   * email_campaign_save / email_campaign_test / email_campaign_send (manager+): save a draft, send a test to
--     yourself, or send once to every subscriber who has given consent. Sending queues one promo_announcement email
--     per subscriber through the existing notification queue (deduplicated per campaign and subscriber, with the
--     subscriber's one-click unsubscribe link). A sent campaign can never be edited or sent again.
--   * member_newsletter_set / member_newsletter_status: a signed-in member opts in or out from Account Settings.
-- Every function: SECURITY DEFINER, search_path '', explicit actor, idempotency key, audit row, service_role only.
-- Campaign text is staff-written marketing copy; it never contains member, ID or health data.

CREATE TABLE public.email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 3 AND 120),
  preheader text CHECK (preheader IS NULL OR length(preheader) <= 150),
  headline text NOT NULL CHECK (length(btrim(headline)) BETWEEN 3 AND 120),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 10 AND 5000),
  cta_label text CHECK (cta_label IS NULL OR length(cta_label) BETWEEN 2 AND 40),
  cta_url text CHECK (cta_url IS NULL OR (cta_url ~ '^https://[^\s<>"]+$' AND length(cta_url) <= 500)),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  recipient_count integer,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_by uuid REFERENCES auth.users(id),
  sent_at timestamptz,
  CHECK ((cta_label IS NULL) = (cta_url IS NULL)),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
ALTER TABLE public.email_campaigns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_campaigns FROM anon, authenticated;
GRANT ALL ON public.email_campaigns TO service_role;

CREATE OR REPLACE FUNCTION public._campaign_data(c public.email_campaigns)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('campaign_id', c.id, 'subject', c.subject, 'preheader', c.preheader,
    'headline', c.headline, 'body', c.body, 'cta_label', c.cta_label, 'cta_url', c.cta_url))
$$;

CREATE OR REPLACE FUNCTION public.email_campaign_save(
  p_actor uuid, p_id uuid, p_subject text, p_preheader text, p_headline text, p_body text,
  p_cta_label text, p_cta_url text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_row public.email_campaigns;
  v_label text := NULLIF(btrim(COALESCE(p_cta_label, '')), '');
  v_url text := NULLIF(btrim(COALESCE(p_cta_url, '')), '');
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  v_cached := public._idem_begin('email_campaign_save', p_actor, p_idempotency_key,
    jsonb_build_object('id', p_id, 's', p_subject, 'p', p_preheader, 'h', p_headline, 'b', p_body,
                       'l', v_label, 'u', v_url));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF (v_label IS NULL) <> (v_url IS NULL) THEN
    RAISE EXCEPTION 'invalid_input: a button needs both a label and a link';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.email_campaigns (subject, preheader, headline, body, cta_label, cta_url, created_by, updated_by)
    VALUES (btrim(p_subject), NULLIF(btrim(COALESCE(p_preheader, '')), ''), btrim(p_headline), btrim(p_body),
            v_label, v_url, p_actor, p_actor)
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.email_campaigns
    SET subject = btrim(p_subject), preheader = NULLIF(btrim(COALESCE(p_preheader, '')), ''),
        headline = btrim(p_headline), body = btrim(p_body), cta_label = v_label, cta_url = v_url,
        updated_by = p_actor, updated_at = now()
    WHERE id = p_id AND status = 'draft'
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign_not_editable: only an unsent draft can be changed';
    END IF;
  END IF;
  PERFORM public._audit(p_actor, 'email_campaign_saved', 'email_campaign', v_row.id,
    jsonb_build_object('subject', v_row.subject, 'new', p_id IS NULL));
  RETURN public._idem_finish('email_campaign_save', p_actor, p_idempotency_key,
    jsonb_build_object('id', v_row.id, 'status', v_row.status));
END;
$$;

CREATE OR REPLACE FUNCTION public.email_campaign_test(p_actor uuid, p_id uuid, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_row public.email_campaigns;
  v_email text;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  v_cached := public._idem_begin('email_campaign_test', p_actor, p_idempotency_key, jsonb_build_object('id', p_id));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT * INTO v_row FROM public.email_campaigns WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: campaign'; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;
  IF v_email IS NULL THEN RAISE EXCEPTION 'invalid_input: your account has no email address'; END IF;
  -- A test goes only to the person asking, marked as staff mail (no marketing consent involved).
  PERFORM public.notification_enqueue('email', 'promo_announcement', v_email, p_actor, 'staff',
    public._campaign_data(v_row) || jsonb_build_object('test', true),
    'campaign-test:' || v_row.id::text || ':' || md5(p_idempotency_key));
  PERFORM public._audit(p_actor, 'email_campaign_test_sent', 'email_campaign', v_row.id, '{}'::jsonb);
  RETURN public._idem_finish('email_campaign_test', p_actor, p_idempotency_key,
    jsonb_build_object('id', v_row.id, 'sent_to', v_email));
END;
$$;

CREATE OR REPLACE FUNCTION public.email_campaign_send(p_actor uuid, p_id uuid, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_row public.email_campaigns;
  v_data jsonb;
  r record;
  v_n integer := 0;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager'::public.app_role);
  v_cached := public._idem_begin('email_campaign_send', p_actor, p_idempotency_key, jsonb_build_object('id', p_id));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT * INTO v_row FROM public.email_campaigns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found: campaign'; END IF;
  IF v_row.status <> 'draft' THEN
    RAISE EXCEPTION 'campaign_already_sent: this campaign was already sent';
  END IF;
  v_data := public._campaign_data(v_row);
  FOR r IN SELECT id, email, unsubscribe_token FROM public.newsletter_subscribers WHERE unsubscribed_at IS NULL
  LOOP
    IF public.notification_enqueue('email', 'promo_announcement', r.email, NULL, 'marketing',
         v_data || jsonb_build_object('consent', 'true', 'unsubscribe_token', r.unsubscribe_token),
         'campaign:' || v_row.id::text || ':' || r.id::text) IS NOT NULL THEN
      v_n := v_n + 1;
    END IF;
  END LOOP;
  UPDATE public.email_campaigns
  SET status = 'sent', sent_at = now(), sent_by = p_actor, recipient_count = v_n
  WHERE id = v_row.id;
  PERFORM public._audit(p_actor, 'email_campaign_sent', 'email_campaign', v_row.id,
    jsonb_build_object('subject', v_row.subject, 'recipients', v_n));
  RETURN public._idem_finish('email_campaign_send', p_actor, p_idempotency_key,
    jsonb_build_object('id', v_row.id, 'status', 'sent', 'recipients', v_n));
END;
$$;

-- A signed-in member's own marketing-email choice (the same list as the website footer sign-up).
CREATE OR REPLACE FUNCTION public.member_newsletter_status(p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.newsletter_subscribers s JOIN auth.users u ON lower(u.email) = lower(s.email)
                 WHERE u.id = p_user AND s.unsubscribed_at IS NULL)
$$;

CREATE OR REPLACE FUNCTION public.member_newsletter_set(p_user uuid, p_subscribe boolean, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_email text;
BEGIN
  PERFORM public._require_read_committed();
  IF p_user IS NULL OR p_subscribe IS NULL THEN RAISE EXCEPTION 'invalid_input'; END IF;
  v_cached := public._idem_begin('member_newsletter_set', p_user, p_idempotency_key,
    jsonb_build_object('on', p_subscribe));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_user;
  IF v_email IS NULL THEN RAISE EXCEPTION 'invalid_input: no email on this account'; END IF;
  IF p_subscribe THEN
    PERFORM public.newsletter_subscribe(v_email, NULL, 'account_settings');
  ELSE
    UPDATE public.newsletter_subscribers SET unsubscribed_at = now()
    WHERE lower(email) = lower(v_email) AND unsubscribed_at IS NULL;
  END IF;
  PERFORM public._audit(p_user, CASE WHEN p_subscribe THEN 'newsletter_opt_in' ELSE 'newsletter_opt_out' END,
    'user', p_user, jsonb_build_object('source', 'account_settings'));
  RETURN public._idem_finish('member_newsletter_set', p_user, p_idempotency_key,
    jsonb_build_object('subscribed', p_subscribe));
END;
$$;

REVOKE ALL ON FUNCTION public._campaign_data(public.email_campaigns),
  public.email_campaign_save(uuid, uuid, text, text, text, text, text, text, text),
  public.email_campaign_test(uuid, uuid, text), public.email_campaign_send(uuid, uuid, text),
  public.member_newsletter_status(uuid), public.member_newsletter_set(uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._campaign_data(public.email_campaigns),
  public.email_campaign_save(uuid, uuid, text, text, text, text, text, text, text),
  public.email_campaign_test(uuid, uuid, text), public.email_campaign_send(uuid, uuid, text),
  public.member_newsletter_status(uuid), public.member_newsletter_set(uuid, boolean, text)
  TO service_role;
