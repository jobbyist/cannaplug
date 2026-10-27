-- Rollback for 20261027002000_id_check_credits: no credit charging, blocking or alerts. The ledger is dropped.
DROP TRIGGER IF EXISTS customer_verification_id_credit ON public.customer_verification;
DROP FUNCTION IF EXISTS public._id_credit_on_submission();
DROP FUNCTION IF EXISTS public.id_credits_open();
DROP FUNCTION IF EXISTS public.id_credits_set_reserve(uuid, integer, text, text);
DROP FUNCTION IF EXISTS public.id_credits_top_up(uuid, integer, text, text);
DROP FUNCTION IF EXISTS public.id_credits_summary(uuid);
DROP FUNCTION IF EXISTS public._id_credit_charge(uuid);
DROP FUNCTION IF EXISTS public._id_credit_maybe_alert(uuid);
DROP FUNCTION IF EXISTS public._id_credit_balance();
DROP TABLE IF EXISTS public.id_credit_ledger;
DROP FUNCTION IF EXISTS public._id_credit_ledger_immutable();
DROP TABLE IF EXISTS public.id_credit_settings;
