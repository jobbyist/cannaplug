-- Rollback for 20261004004000_audit_hardening.sql (removes the triggers; existing audit rows are kept).
BEGIN;
DROP TRIGGER IF EXISTS customer_verification_audit ON public.customer_verification;
DROP TRIGGER IF EXISTS user_roles_audit ON public.user_roles;
DROP TRIGGER IF EXISTS order_status_history_audit ON public.order_status_history;
DROP TRIGGER IF EXISTS pos_sales_audit ON public.pos_sales;
DROP TRIGGER IF EXISTS audit_log_no_truncate ON public.audit_log;
DROP TRIGGER IF EXISTS audit_log_no_update_delete ON public.audit_log;
DROP FUNCTION IF EXISTS public._audit_id_verification();
DROP FUNCTION IF EXISTS public._audit_user_roles();
DROP FUNCTION IF EXISTS public._audit_order_status();
DROP FUNCTION IF EXISTS public._audit_pos_sale();
DROP FUNCTION IF EXISTS public._audit_log_immutable();
DROP INDEX IF EXISTS public.audit_log_action_idx, public.audit_log_actor_idx, public.audit_log_created_idx;
COMMIT;
