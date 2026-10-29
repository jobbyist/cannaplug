-- Rollback for 20261031001000_commerce_suspension: POS and online checkout are no longer gated by the database.
-- The server code must be reverted first (it calls commerce_suspension_status). Suspension history is dropped with the table.
DROP TRIGGER IF EXISTS commerce_resume_on_payment ON public.billing_payments;
DROP FUNCTION IF EXISTS public._commerce_resume_on_payment();
DROP FUNCTION IF EXISTS public.commerce_resume(uuid, text, text);
DROP FUNCTION IF EXISTS public.commerce_suspend(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.commerce_suspension_status();
DROP TABLE IF EXISTS public.commerce_suspensions;
