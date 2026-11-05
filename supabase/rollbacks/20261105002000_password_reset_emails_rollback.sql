-- Rollback for 20261105002000_password_reset_emails: removes the reset-email functions and table and restores the
-- email budget count from 20261027004000. Roll the app back first (Forgot password calls password_reset_begin).
-- Reset emails already sent are only lost from the 24-hour count, which corrects itself within a day.
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
DROP FUNCTION IF EXISTS public.password_reset_finish(uuid, text);
DROP FUNCTION IF EXISTS public.password_reset_begin(text, text, uuid, text);
DROP FUNCTION IF EXISTS public._password_reset_email_hash(text);
DROP TABLE IF EXISTS public.password_reset_requests;
