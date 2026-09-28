-- Rollback for 20260929002000_customer_staff_rbac.
-- Run manually only after reverting the application code. All non-admin staff
-- roles map back to legacy member because the old enum cannot represent them.
--
-- This file is intentionally explicit and destructive only as a rollback path:
-- addresses/customer_verification/audit_log are dropped after their replacement
-- data access has been disabled. Do not run automatically.

BEGIN;

DROP FUNCTION IF EXISTS public.role_level(public.app_role);
DROP FUNCTION IF EXISTS public.current_user_role();
DROP FUNCTION IF EXISTS public.has_at_least_role(public.app_role);
DROP FUNCTION IF EXISTS public.is_staff();
DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);

-- Restore original grants/policies first.
DROP POLICY IF EXISTS "profiles select own or staff" ON public.profiles;
DROP POLICY IF EXISTS "profiles insert self" ON public.profiles;
DROP POLICY IF EXISTS "profiles update own or management" ON public.profiles;

DROP POLICY IF EXISTS "products active public read" ON public.products;
DROP POLICY IF EXISTS "products staff read" ON public.products;
DROP POLICY IF EXISTS "products management insert" ON public.products;
DROP POLICY IF EXISTS "products management update" ON public.products;
DROP POLICY IF EXISTS "products management delete" ON public.products;

DROP POLICY IF EXISTS "orders select own or staff" ON public.orders;
DROP POLICY IF EXISTS "orders insert self" ON public.orders;
DROP POLICY IF EXISTS "orders update staff" ON public.orders;

DROP POLICY IF EXISTS "order items select own or staff" ON public.order_items;
DROP POLICY IF EXISTS "order items insert own validated product" ON public.order_items;

DROP POLICY IF EXISTS "user roles select own or management" ON public.user_roles;
DROP POLICY IF EXISTS "user roles admin insert" ON public.user_roles;
DROP POLICY IF EXISTS "user roles admin update" ON public.user_roles;
DROP POLICY IF EXISTS "user roles admin delete" ON public.user_roles;

DROP POLICY IF EXISTS "addresses select own or staff" ON public.addresses;
DROP POLICY IF EXISTS "addresses insert self" ON public.addresses;
DROP POLICY IF EXISTS "addresses update own or management" ON public.addresses;
DROP POLICY IF EXISTS "addresses delete own or management" ON public.addresses;

DROP POLICY IF EXISTS "verification select own or staff" ON public.customer_verification;
DROP POLICY IF EXISTS "verification management insert" ON public.customer_verification;
DROP POLICY IF EXISTS "verification management update" ON public.customer_verification;

DROP POLICY IF EXISTS "audit log management read" ON public.audit_log;

-- Restore legacy function grants and policies.
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;

CREATE POLICY "own profile select" ON public.profiles
FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = id);

CREATE POLICY "own profile insert" ON public.profiles
FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "own profile update" ON public.profiles
FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = id)
WITH CHECK ((SELECT auth.uid()) = id);

GRANT SELECT ON public.products TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.products FROM authenticated;
CREATE POLICY "products public read" ON public.products
FOR SELECT TO anon, authenticated USING (is_active);

GRANT SELECT, INSERT ON public.orders TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.order_number_seq TO authenticated, service_role;

CREATE POLICY "own orders select" ON public.orders
FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "own orders insert" ON public.orders
FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);

GRANT SELECT, INSERT ON public.order_items TO authenticated;

CREATE POLICY "own order items select" ON public.order_items
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.orders AS o
    WHERE o.id = order_id AND o.user_id = (SELECT auth.uid())
  )
);

CREATE POLICY "own order items insert" ON public.order_items
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.orders AS o
    WHERE o.id = order_id AND o.user_id = (SELECT auth.uid())
  )
);

-- Recreate legacy enum and map staff roles back to member.
CREATE TYPE public.app_role_rollback AS ENUM ('admin', 'member');

ALTER TABLE public.user_roles
  ALTER COLUMN role TYPE public.app_role_rollback
  USING (
    CASE
      WHEN role::text = 'admin' THEN 'admin'
      ELSE 'member'
    END
  )::public.app_role_rollback;

DROP TYPE public.app_role;
ALTER TYPE public.app_role_rollback RENAME TO app_role;

GRANT SELECT ON public.user_roles TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated;

CREATE POLICY "Users can read own roles" ON public.user_roles
FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    _user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.user_roles AS ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = _role
    )
$$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;

-- Restore the legacy new-user trigger behavior.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, phone, date_of_birth, address)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'phone',
    NULLIF(NEW.raw_user_meta_data ->> 'date_of_birth', '')::date,
    NEW.raw_user_meta_data ->> 'address'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Remove rollback-only structures. Existing profile.address remains intact.
DROP TABLE public.audit_log;
DROP TABLE public.customer_verification;
DROP TABLE public.addresses;

COMMIT;
