-- Rollback for 20261023006000_web_push. Queued push rows are transient and are removed with the channel.
DROP TRIGGER IF EXISTS notification_events_push_fanout ON public.notification_events;
DROP TRIGGER IF EXISTS articles_journal_push ON public.articles;
DROP FUNCTION IF EXISTS public._notification_push_fanout();
DROP FUNCTION IF EXISTS public._journal_push();
DROP FUNCTION IF EXISTS public.notification_enqueue_push(uuid, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.notification_claim_channels(integer, integer, text[]);
DROP FUNCTION IF EXISTS public.push_subscribe(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.push_unsubscribe(uuid, text);
DROP FUNCTION IF EXISTS public.notification_set_preference(uuid, text, boolean, text);
DROP FUNCTION IF EXISTS public.push_record_delivery(text, text);
DROP FUNCTION IF EXISTS public._push_enabled(uuid, text);
DROP FUNCTION IF EXISTS public.push_quiet_hours_release(timestamptz);
DROP FUNCTION IF EXISTS public.push_topic_for(text);
DROP FUNCTION IF EXISTS public.push_topic_meta(text);
DROP TABLE IF EXISTS public.notification_preferences;
DROP TABLE IF EXISTS public.push_subscriptions;
DELETE FROM public.notification_events WHERE channel = 'push';
ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_channel_check;
ALTER TABLE public.notification_events ADD CONSTRAINT notification_events_channel_check
  CHECK (channel IN ('email', 'sms', 'whatsapp'));
