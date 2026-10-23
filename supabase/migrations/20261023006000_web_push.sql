-- Prompt 7 (23 Oct 2026): web push as a fourth channel on the existing notification queue.
--
--   * push_subscriptions        one row per browser/device (endpoint + keys); a member reads only their own (not the keys)
--   * notification_preferences  per user and topic; transactional topics default on, marketing topics default off
--   * notification_events       channel check gains 'push'
--   * fan-out                   every queued email to a known user also queues ONE push row for that user when they
--                               have a device and the topic is on (same dedupe key + ':push'), so every existing
--                               enqueue point (order status, staff alerts, ID decisions, back in stock, promos) gets
--                               push without touching a request path. Marketing pushes wait for 07:00 SAST if queued
--                               during quiet hours (21:00-07:00).
--   * new Journal article       push to members who opted into the 'journal' topic
--   * notification_claim_channels   claims only the channels the dispatcher can send, so an unconfigured email key
--                               never burns push attempts (and vice versa)
-- Push payloads are built in the app from the template name and carry a title, a neutral body and a URL only.

ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_channel_check;
ALTER TABLE public.notification_events ADD CONSTRAINT notification_events_channel_check
  CHECK (channel IN ('email', 'sms', 'whatsapp', 'push'));

CREATE TABLE public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  -- empty = every topic the member has switched on; otherwise only these topics on this device
  topics text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0)
);
CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions (user_id);

CREATE TABLE public.notification_preferences (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  topic text NOT NULL,
  push_enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);

-- Topics. staff_* are offered to staff only; marketing topics are opt-in and respect quiet hours.
CREATE OR REPLACE FUNCTION public.push_topic_meta(p_topic text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE p_topic
    WHEN 'orders'         THEN '{"default": true,  "marketing": false, "staff": false}'::jsonb
    WHEN 'account'        THEN '{"default": true,  "marketing": false, "staff": false}'::jsonb
    WHEN 'back_in_stock'  THEN '{"default": true,  "marketing": false, "staff": false}'::jsonb
    WHEN 'journal'        THEN '{"default": false, "marketing": true,  "staff": false}'::jsonb
    WHEN 'promos'         THEN '{"default": false, "marketing": true,  "staff": false}'::jsonb
    WHEN 'staff_orders'   THEN '{"default": true,  "marketing": false, "staff": true}'::jsonb
    WHEN 'staff_stock'    THEN '{"default": true,  "marketing": false, "staff": true}'::jsonb
    WHEN 'staff_payments' THEN '{"default": true,  "marketing": false, "staff": true}'::jsonb
    WHEN 'staff_id'       THEN '{"default": true,  "marketing": false, "staff": true}'::jsonb
    ELSE NULL END;
$$;

-- Which topic a notification template belongs to (NULL = never pushed).
CREATE OR REPLACE FUNCTION public.push_topic_for(p_template text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_template IN ('order_received', 'order_confirmed', 'order_ready', 'order_out_for_delivery',
                        'order_completed', 'order_cancelled') THEN 'orders'
    WHEN p_template IN ('id_approved', 'id_rejected', 'id_expiring', 'document_ready') THEN 'account'
    WHEN p_template = 'back_in_stock' THEN 'back_in_stock'
    WHEN p_template IN ('journal_digest', 'journal_new') THEN 'journal'
    WHEN p_template = 'promo_announcement' THEN 'promos'
    WHEN p_template = 'staff_new_order' THEN 'staff_orders'
    WHEN p_template = 'staff_low_stock' THEN 'staff_stock'
    WHEN p_template IN ('staff_payment_review', 'staff_refund_needed', 'staff_eft_approval') THEN 'staff_payments'
    WHEN p_template = 'staff_id_review' THEN 'staff_id'
    WHEN p_template = 'push_test' THEN 'test'
    ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION public._push_enabled(p_user uuid, p_topic text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_topic = 'test' THEN true
    WHEN public.push_topic_meta(p_topic) IS NULL THEN false
    ELSE COALESCE(
      (SELECT np.push_enabled FROM public.notification_preferences np WHERE np.user_id = p_user AND np.topic = p_topic),
      (public.push_topic_meta(p_topic)->>'default')::boolean)
  END;
$$;

-- Next moment a marketing push may go out: now, or 07:00 SAST if it is between 21:00 and 07:00 SAST.
CREATE OR REPLACE FUNCTION public.push_quiet_hours_release(p_now timestamptz)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  v_local timestamp := p_now AT TIME ZONE 'Africa/Johannesburg';
  v_hour integer := extract(hour FROM v_local);
BEGIN
  IF v_hour >= 21 THEN
    RETURN ((v_local::date + 1) + time '07:00') AT TIME ZONE 'Africa/Johannesburg';
  ELSIF v_hour < 7 THEN
    RETURN (v_local::date + time '07:00') AT TIME ZONE 'Africa/Johannesburg';
  END IF;
  RETURN p_now;
END;
$$;

-- Queue one push row for a user (only if they have a device that takes this topic and the topic is on).
CREATE OR REPLACE FUNCTION public.notification_enqueue_push(
  p_user uuid, p_template text, p_category text, p_data jsonb, p_dedupe_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_topic text := public.push_topic_for(p_template);
  v_marketing boolean;
  v_id uuid;
BEGIN
  IF p_user IS NULL OR v_topic IS NULL OR NOT public._push_enabled(p_user, v_topic) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.push_subscriptions s
                 WHERE s.user_id = p_user AND (s.topics = '{}' OR v_topic = ANY (s.topics) OR v_topic = 'test')) THEN
    RETURN NULL;
  END IF;
  v_marketing := COALESCE((public.push_topic_meta(v_topic)->>'marketing')::boolean, false);
  INSERT INTO public.notification_events
    (channel, category, template, recipient, recipient_user_id, data, dedupe_key, next_attempt_at, max_attempts)
  VALUES ('push', CASE WHEN v_marketing THEN 'marketing' ELSE COALESCE(p_category, 'transactional') END,
          p_template, p_user::text, p_user,
          -- the opt-in to a marketing topic IS the recorded consent for this channel
          COALESCE(p_data, '{}'::jsonb) || jsonb_build_object('push_topic', v_topic)
            || CASE WHEN v_marketing THEN '{"consent": "true"}'::jsonb ELSE '{}'::jsonb END,
          p_dedupe_key,
          CASE WHEN v_marketing THEN public.push_quiet_hours_release(now()) ELSE now() END,
          4)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public._notification_push_fanout()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.channel = 'email' AND NEW.recipient_user_id IS NOT NULL THEN
    BEGIN
      PERFORM public.notification_enqueue_push(NEW.recipient_user_id, NEW.template, NEW.category, NEW.data,
                                               NEW.dedupe_key || ':push');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'push fan-out skipped: %', SQLERRM;  -- push must never block the email or the business event
    END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER notification_events_push_fanout AFTER INSERT ON public.notification_events
  FOR EACH ROW EXECUTE FUNCTION public._notification_push_fanout();

-- A new Journal article: push to members who opted into 'journal'.
CREATE OR REPLACE FUNCTION public._journal_push()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
BEGIN
  BEGIN
    FOR r IN SELECT DISTINCT np.user_id FROM public.notification_preferences np
             WHERE np.topic = 'journal' AND np.push_enabled
    LOOP
      PERFORM public.notification_enqueue_push(r.user_id, 'journal_new', 'marketing',
        jsonb_build_object('slug', NEW.slug, 'title', left(NEW.title, 90)),
        'journalpush:' || NEW.id::text || ':' || r.user_id::text);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'journal push skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER articles_journal_push AFTER INSERT ON public.articles
  FOR EACH ROW EXECUTE FUNCTION public._journal_push();

-- Claim only the channels this dispatcher can actually send.
CREATE OR REPLACE FUNCTION public.notification_claim_channels(
  p_limit integer, p_lease_seconds integer, p_channels text[]
) RETURNS SETOF public.notification_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT n.id FROM public.notification_events n
    WHERE n.channel = ANY (COALESCE(p_channels, '{}'))
      AND ((n.status IN ('queued', 'failed') AND n.next_attempt_at <= now())
        OR (n.status = 'sending' AND n.locked_until < now()))
    ORDER BY n.priority, n.next_attempt_at
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notification_events n
  SET status = 'sending', attempts = n.attempts + 1,
      locked_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 10))
  FROM due WHERE n.id = due.id
  RETURNING n.*;
END;
$$;

-- ---------------------------------------------------------------------------
-- Member actions (called by the server with the signed-in user's id; never directly by a browser)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.push_subscribe(
  p_actor uuid, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_actor) THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  v_cached := public._idem_begin('push_subscribe', p_actor, p_idempotency_key,
    jsonb_build_object('endpoint', md5(COALESCE(p_endpoint, ''))));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF (SELECT count(*) FROM public.push_subscriptions WHERE user_id = p_actor) >= 10
     AND NOT EXISTS (SELECT 1 FROM public.push_subscriptions WHERE endpoint = p_endpoint) THEN
    RAISE EXCEPTION 'too_many_devices: remove a device first (10 at most)';
  END IF;
  -- The same endpoint re-registered (new keys, or a different member signing in on this device) moves to the
  -- current member: a browser endpoint belongs to whoever is signed in on it now.
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  VALUES (p_actor, btrim(p_endpoint), p_p256dh, p_auth, left(p_user_agent, 300))
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent, failure_count = 0
  RETURNING id INTO v_id;
  PERFORM public._audit(p_actor, 'push_subscribed', 'push_subscription', v_id, '{}'::jsonb);
  v_response := jsonb_build_object('subscription_id', v_id);
  RETURN public._idem_finish('push_subscribe', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.push_unsubscribe(p_actor uuid, p_endpoint text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM public.push_subscriptions WHERE user_id = p_actor AND endpoint = p_endpoint;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN PERFORM public._audit(p_actor, 'push_unsubscribed', 'push_subscription', NULL, '{}'::jsonb); END IF;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.notification_set_preference(
  p_actor uuid, p_topic text, p_enabled boolean, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_meta jsonb := public.push_topic_meta(p_topic);
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF v_meta IS NULL THEN RAISE EXCEPTION 'unknown_topic'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'invalid_preference'; END IF;
  IF (v_meta->>'staff')::boolean THEN
    PERFORM public._assert_staff(p_actor, 'budtender'::public.app_role);
  ELSIF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_actor) THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  v_cached := public._idem_begin('notification_set_preference', p_actor, p_idempotency_key,
    jsonb_build_object('topic', p_topic, 'enabled', p_enabled));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  INSERT INTO public.notification_preferences (user_id, topic, push_enabled, updated_at)
  VALUES (p_actor, p_topic, p_enabled, now())
  ON CONFLICT (user_id, topic) DO UPDATE SET push_enabled = EXCLUDED.push_enabled, updated_at = now();
  -- Consent for marketing push is recorded like any other consent change.
  PERFORM public._audit(p_actor, 'notification_preference_set', 'notification_preferences', NULL,
    jsonb_build_object('topic', p_topic, 'enabled', p_enabled));
  v_response := jsonb_build_object('topic', p_topic, 'enabled', p_enabled);
  RETURN public._idem_finish('notification_set_preference', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Delivery bookkeeping from the dispatcher: a gone endpoint (404/410) is removed; repeated failures too.
CREATE OR REPLACE FUNCTION public.push_record_delivery(p_endpoint text, p_outcome text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF p_outcome = 'ok' THEN
    UPDATE public.push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE endpoint = p_endpoint;
  ELSIF p_outcome = 'gone' THEN
    DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
  ELSE
    UPDATE public.push_subscriptions SET failure_count = failure_count + 1 WHERE endpoint = p_endpoint;
    DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint AND failure_count >= 20;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- RLS and grants: members can read their own devices and preferences; every write (adding or removing a device,
-- changing a topic) goes through the functions above via the server, so browser roles get no write grants.
-- ---------------------------------------------------------------------------

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_subscriptions, public.notification_preferences FROM anon, authenticated;
GRANT SELECT (id, user_id, user_agent, topics, created_at, last_success_at) ON public.push_subscriptions TO authenticated;
GRANT SELECT ON public.notification_preferences TO authenticated;
GRANT ALL ON public.push_subscriptions, public.notification_preferences TO service_role;
CREATE POLICY "own push devices read" ON public.push_subscriptions FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY "own notification preferences read" ON public.notification_preferences FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._push_enabled(uuid, text)',
    'public.notification_enqueue_push(uuid, text, text, jsonb, text)',
    'public._notification_push_fanout()',
    'public._journal_push()',
    'public.notification_claim_channels(integer, integer, text[])',
    'public.push_subscribe(uuid, text, text, text, text, text)',
    'public.push_unsubscribe(uuid, text)',
    'public.notification_set_preference(uuid, text, boolean, text)',
    'public.push_record_delivery(text, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;
