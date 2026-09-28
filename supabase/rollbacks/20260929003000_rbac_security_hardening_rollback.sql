-- Rollback for 20260929003000_rbac_security_hardening.
-- Explicitly guarded because removing referential integrity can re-open data
-- integrity gaps and should never happen accidentally.

BEGIN;

DO $$
BEGIN
  IF current_setting('app.confirm_rollback', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Rollback requires: SET app.confirm_rollback = ''yes'';';
  END IF;
END
$$;

ALTER TABLE public.order_items
  DROP CONSTRAINT IF EXISTS fk_order_items_product_id;

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS fk_audit_log_actor_user_id,
  DROP CONSTRAINT IF EXISTS fk_audit_log_target_user_id;

ALTER TABLE public.customer_verification
  DROP CONSTRAINT IF EXISTS fk_customer_verification_user_id,
  DROP CONSTRAINT IF EXISTS fk_customer_verification_verified_by;

ALTER TABLE public.addresses
  DROP CONSTRAINT IF EXISTS fk_addresses_user_id;

COMMIT;
