-- CannaPlug RBAC security hardening for Amazon Q findings 1, 3 and 6.
-- Safe to apply after 20260929002000_customer_staff_rbac.
-- All changes are transactional; FK validation fails closed if legacy orphaned
-- references exist, rather than silently deleting or rewriting production data.

BEGIN;

-- Issue 1: enforce referential integrity for customer-owned and audit data.
ALTER TABLE public.addresses
  ADD CONSTRAINT fk_addresses_user_id
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.customer_verification
  ADD CONSTRAINT fk_customer_verification_user_id
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.customer_verification
  ADD CONSTRAINT fk_customer_verification_verified_by
  FOREIGN KEY (verified_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.audit_log
  ADD CONSTRAINT fk_audit_log_actor_user_id
  FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.audit_log
  ADD CONSTRAINT fk_audit_log_target_user_id
  FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Preserve order history: a product referenced by an order item cannot be
-- physically deleted. The catalogue can instead be soft-deactivated.
ALTER TABLE public.order_items
  ADD CONSTRAINT fk_order_items_product_id
  FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;

-- Issue 3: keep the intended ordering invariant explicit for future maintainers.
-- The canonical RBAC migration enables RLS before exposing authenticated writes.
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Issue 6: managers can maintain catalogue state via UPDATE (including
-- is_active=false), but only admins may request a physical DELETE. The FK above
-- additionally blocks deletion of products referenced by historical orders.
DROP POLICY IF EXISTS "products management delete" ON public.products;
DROP POLICY IF EXISTS "products admin hard delete" ON public.products;

CREATE POLICY "products admin hard delete"
ON public.products FOR DELETE TO authenticated
USING ((SELECT public.has_at_least_role('admin'::public.app_role)));

COMMIT;
