-- Rollback for 20261004001000_public_forms.sql. WARNING: drops stored contact messages and newsletter consent
-- records — export them first if the release has received real submissions.
BEGIN;
DROP FUNCTION IF EXISTS public.contact_submit(text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.newsletter_subscribe(text, text, text);
DROP FUNCTION IF EXISTS public.newsletter_unsubscribe(text);
DROP TABLE IF EXISTS public.contact_submissions, public.newsletter_subscribers;
COMMIT;
