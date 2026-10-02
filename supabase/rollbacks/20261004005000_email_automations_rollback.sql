-- Rollback for 20261004005000_email_automations.sql (queued rows already created are left to drain or be purged).
BEGIN;
DROP TRIGGER IF EXISTS customer_verification_email ON public.customer_verification;
DROP TRIGGER IF EXISTS profiles_welcome_email ON public.profiles;
DROP FUNCTION IF EXISTS public.email_automations_run(timestamptz);
DROP FUNCTION IF EXISTS public._notify_id_verification();
DROP FUNCTION IF EXISTS public._notify_member_welcome();
COMMIT;
