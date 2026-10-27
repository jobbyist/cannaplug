-- 27 Oct 2026: keep Resend under its free-plan quota (100 emails a day) and send only the emails that matter.
--   * ID emails: no "we received your ID" email to the member and no "ID waiting for review" email to staff (staff
--     see the ID checks tab). On approval the member gets ONE email: the welcome email, now saying their ID
--     verification was successful (a later re-verification after an expired document gets the short approval
--     email instead). A rejection still emails the member, who must upload again. Sign-up itself sends nothing.
--   * Daily budget: notification_claim only hands out email while the last 24 hours stay under the budget,
--     counting queued emails sent and till receipts emailed. 5 of the 100 are kept back for Supabase's own
--     emails (password resets). Priorities: high (orders, payments, receipts, welcome, rejected ID, clinical,
--     staff money alerts, daily sales report) up to 95; normal (low-stock digest, back in stock, ID expiring,
--     newsletter welcome) up to 75; low (campaigns, Journal digest) up to 40. Emails over budget simply wait in
--     the queue and go out as the 24-hour window frees up. Queued ID-review and ID-received emails are
--     suppressed.
--   * email_budget_status(): what has been used, for /admin and the till's receipt button.

CREATE TABLE IF NOT EXISTS public.email_budget_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  daily_limit integer NOT NULL DEFAULT 100 CHECK (daily_limit BETWEEN 1 AND 100000),
  reserved_for_auth integer NOT NULL DEFAULT 5 CHECK (reserved_for_auth >= 0),
  normal_ceiling integer NOT NULL DEFAULT 75 CHECK (normal_ceiling >= 0),
  low_ceiling integer NOT NULL DEFAULT 40 CHECK (low_ceiling >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.email_budget_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.email_budget_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_budget_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_budget_settings TO service_role;

CREATE INDEX IF NOT EXISTS notification_events_sent_idx ON public.notification_events (sent_at DESC)
  WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS pos_receipt_sends_created_idx ON public.pos_receipt_sends (created_at DESC);

-- 1 = high, 2 = normal, 3 = low, 0 = never sent.
CREATE OR REPLACE FUNCTION public._email_tier(p_template text)
RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_template IN ('staff_id_review', 'id_submitted') THEN 0
    WHEN p_template IN ('promo_announcement', 'journal_digest') THEN 3
    WHEN p_template IN ('staff_low_stock', 'back_in_stock', 'id_expiring', 'newsletter_welcome',
                        'contact_form_ack', 'id_approved') THEN 2
    ELSE 1
  END;
$$;
REVOKE ALL ON FUNCTION public._email_tier(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._email_tier(text) TO service_role;

CREATE OR REPLACE FUNCTION public._emails_sent_24h()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT ((SELECT count(*) FROM public.notification_events
           WHERE channel = 'email' AND status = 'sent' AND sent_at > now() - interval '24 hours')
        + (SELECT count(*) FROM public.notification_events
           WHERE channel = 'email' AND status = 'sending' AND locked_until > now())
        + (SELECT count(*) FROM public.pos_receipt_sends WHERE created_at > now() - interval '24 hours'))::integer;
$$;
REVOKE ALL ON FUNCTION public._emails_sent_24h() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._emails_sent_24h() TO service_role;

CREATE OR REPLACE FUNCTION public.email_budget_status()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'used', public._emails_sent_24h(),
    'limit', s.daily_limit,
    'usable', s.daily_limit - s.reserved_for_auth,
    'normal_ceiling', s.normal_ceiling,
    'low_ceiling', s.low_ceiling,
    'waiting', (SELECT count(*) FROM public.notification_events
                WHERE channel = 'email' AND status IN ('queued', 'failed')),
    'receipts_open', public._emails_sent_24h() < s.daily_limit - s.reserved_for_auth)
  FROM public.email_budget_settings s WHERE s.id;
$$;
REVOKE ALL ON FUNCTION public.email_budget_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_budget_status() TO service_role;

-- Claim due notifications; email only within the budget, highest priority first. Other channels are unchanged.
CREATE OR REPLACE FUNCTION public.notification_claim(p_limit integer, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.notification_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  s public.email_budget_settings;
  v_used integer;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100);
  v_ids uuid[] := ARRAY[]::uuid[];
  r record;
  v_tier integer;
  v_ceiling integer;
BEGIN
  -- One claimer at a time, so two dispatch runs cannot both spend the same headroom.
  SELECT * INTO s FROM public.email_budget_settings WHERE id FOR UPDATE;
  v_used := public._emails_sent_24h();
  -- Low-value emails that are no longer sent at all.
  UPDATE public.notification_events SET status = 'suppressed', last_error = 'not sent (email budget policy)'
  WHERE channel = 'email' AND status IN ('queued', 'failed') AND public._email_tier(template) = 0;

  FOR r IN
    SELECT n.id, n.channel, n.template FROM public.notification_events n
    WHERE ((n.status IN ('queued', 'failed') AND n.next_attempt_at <= now())
        OR (n.status = 'sending' AND n.locked_until < now()))
    ORDER BY CASE WHEN n.channel = 'email' THEN public._email_tier(n.template) ELSE 1 END,
             n.priority, n.next_attempt_at
    LIMIT 500
    FOR UPDATE SKIP LOCKED
  LOOP
    EXIT WHEN cardinality(v_ids) >= v_limit;
    IF r.channel = 'email' THEN
      v_tier := public._email_tier(r.template);
      v_ceiling := CASE v_tier WHEN 3 THEN s.low_ceiling WHEN 2 THEN s.normal_ceiling
                               ELSE s.daily_limit - s.reserved_for_auth END;
      CONTINUE WHEN v_used >= v_ceiling;
      v_used := v_used + 1;
    END IF;
    v_ids := v_ids || r.id;
  END LOOP;

  RETURN QUERY
  UPDATE public.notification_events n
  SET status = 'sending', attempts = n.attempts + 1,
      locked_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 10))
  WHERE n.id = ANY (v_ids)
  RETURNING n.*;
END;
$$;
REVOKE ALL ON FUNCTION public.notification_claim(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notification_claim(integer, integer) TO service_role;

-- Sign-up sends nothing any more; the welcome email goes out when the ID is approved.
CREATE OR REPLACE FUNCTION public._notify_member_welcome()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._notify_id_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text;
  v_name text;
  v_stamp text;
  v_data jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('verified', 'rejected') THEN RETURN NEW; END IF;  -- nothing on submission
  BEGIN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.user_id;
    IF v_email IS NULL THEN RETURN NEW; END IF;
    SELECT p.full_name INTO v_name FROM public.profiles p WHERE p.id = NEW.user_id;
    v_stamp := extract(epoch FROM COALESCE(NEW.reviewed_at, now()))::bigint::text;
    v_data := jsonb_build_object('contact_name', v_name, 'rejection_code', NEW.rejection_code,
                                 'document_expires_on', NEW.document_expires_on, 'id_verified', NEW.status = 'verified');
    IF NEW.status = 'verified' THEN
      -- First approval: the welcome email (with "verification successful"). Later re-verifications: the short one.
      IF public.notification_enqueue('email', 'member_welcome', v_email, NEW.user_id, 'transactional', v_data,
                                     'welcome:' || NEW.user_id::text) IS NULL THEN
        PERFORM public.notification_enqueue('email', 'id_approved', v_email, NEW.user_id, 'transactional', v_data,
          'idv:' || NEW.user_id::text || ':verified:' || v_stamp);
      END IF;
    ELSE
      PERFORM public.notification_enqueue('email', 'id_rejected', v_email, NEW.user_id, 'transactional', v_data,
        'idv:' || NEW.user_id::text || ':rejected:' || v_stamp);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'id verification email skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

UPDATE public.notification_events SET status = 'suppressed', last_error = 'not sent (email budget policy)'
WHERE channel = 'email' AND status IN ('queued', 'failed') AND template IN ('staff_id_review', 'id_submitted');
