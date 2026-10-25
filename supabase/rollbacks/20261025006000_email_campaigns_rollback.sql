-- Rollback for 20261025006000_email_campaigns. Drops campaign drafts/history (already-queued emails are unaffected)
-- and the member preference functions; newsletter subscriptions made from Account Settings stay (consent is kept).
DROP FUNCTION IF EXISTS public.member_newsletter_set(uuid, boolean, text);
DROP FUNCTION IF EXISTS public.member_newsletter_status(uuid);
DROP FUNCTION IF EXISTS public.email_campaign_send(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.email_campaign_test(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.email_campaign_save(uuid, uuid, text, text, text, text, text, text, text);
DROP FUNCTION IF EXISTS public._campaign_data(public.email_campaigns);
DROP TABLE IF EXISTS public.email_campaigns;
