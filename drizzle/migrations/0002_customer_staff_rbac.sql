-- CannaPlug RBAC and least-privilege data model.
-- Safe rollout: maps legacy member -> customer, preserves admin, adds new staff tiers,
-- and keeps all changes transactional. See the matching rollback script for reversal.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Role enum migration: admin|member -> customer|budtender|manager|admin
-- ---------------------------------------------------------------------------

CREATE TYPE public.app_role_v2 AS ENUM ('customer', 'budtender', 'manager', 'admin');

DROP FUNCTION IF EXISTS public.has_role(uuid, public.app_role);

ALTER TABLE public.user_roles
  ALTER COLUMN role TYPE public.app_role_v2
  USING (
    CASE role::text
      WHEN 'member' THEN 'customer'
      WHEN 'admin' THEN 'admin'
      WHEN 'budtender' THEN 'budtender'
      WHEN 'manager' THEN 'manager'
      WHEN 'customer' THEN 'customer'
      ELSE 'customer'
    END
  )::public.app_role_v2;

DROP TYPE public.app_role;
ALTER TYPE public.app_role_v2 RENAME TO app_role;

-- Existing users without a role become customers. Existing admin/member rows
-- remain represented as admin/customer rows respectively.
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'customer'::public.app_role
FROM auth.users AS u
WHERE NOT EXISTS (
  SELECT 1
  FROM public.user_roles AS ur
  WHERE ur.user_id = u.id
);

-- ---------------------------------------------------------------------------
-- 2. Role hierarchy helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.role_level(_role public.app_role)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE _role
    WHEN 'customer'::public.app_role THEN 10
    WHEN 'budtender'::public.app_role THEN 20
    WHEN 'manager'::public.app_role THEN 30
    WHEN 'admin'::public.app_role THEN 40
  END::smallint
$$;

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS public.app_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ur.role
  FROM public.user_roles AS ur
  WHERE ur.user_id = (SELECT auth.uid())
  ORDER BY public.role_level(ur.role) DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.has_at_least_role(_required public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    public.role_level(public.current_user_role()) >= public.role_level(_required),
    false
  )
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.has_at_least_role('budtender'::public.app_role)
$$;

-- Compatibility helper: only permits the caller to inspect their own exact role.
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

REVOKE EXECUTE ON FUNCTION public.role_level(public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.current_user_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_at_least_role(public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_staff() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_at_least_role(public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. New customer/staff support tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  label text NOT NULL DEFAULT 'Home',
  recipient_name text,
  phone text,
  line1 text NOT NULL,
  line2 text,
  suburb text,
  city text,
  province text,
  postal_code text,
  country text NOT NULL DEFAULT 'South Africa',
  delivery_notes text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customer_verification (
  user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'pending', 'verified', 'rejected', 'expired')),
  method text,
  verified_at timestamptz,
  verified_by uuid,
  provider_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  target_user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 4. Supporting indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS addresses_user_id_idx
  ON public.addresses (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS addresses_one_default_per_user_idx
  ON public.addresses (user_id)
  WHERE is_default = true;

CREATE INDEX IF NOT EXISTS customer_verification_status_updated_idx
  ON public.customer_verification (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS customer_verification_verified_at_idx
  ON public.customer_verification (verified_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_actor_created_idx
  ON public.audit_log (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_target_created_idx
  ON public.audit_log (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_entity_created_idx
  ON public.audit_log (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orders_user_created_idx
  ON public.orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS orders_status_created_idx
  ON public.orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx
  ON public.order_items (order_id);

CREATE INDEX IF NOT EXISTS order_items_product_id_idx
  ON public.order_items (product_id);

CREATE INDEX IF NOT EXISTS products_active_sort_idx
  ON public.products (is_active, sort_order);

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.addresses TO authenticated;
GRANT ALL ON public.addresses TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.customer_verification TO authenticated;
GRANT ALL ON public.customer_verification TO service_role;

GRANT SELECT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.order_number_seq TO authenticated, service_role;

GRANT SELECT, INSERT ON public.order_items TO authenticated;
GRANT ALL ON public.order_items TO service_role;

GRANT SELECT ON public.products TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;

-- Restrict write columns so staff/customer policies cannot reassign ownership.
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;
GRANT INSERT (id, full_name, phone, date_of_birth, address)
  ON public.profiles TO authenticated;
GRANT UPDATE (full_name, phone, date_of_birth, address, updated_at)
  ON public.profiles TO authenticated;

REVOKE INSERT, UPDATE ON public.orders FROM authenticated;
GRANT INSERT (user_id, contact_name, contact_phone, notes)
  ON public.orders TO authenticated;
GRANT UPDATE (status, contact_name, contact_phone, notes)
  ON public.orders TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.addresses FROM authenticated;
GRANT INSERT (
  user_id, label, recipient_name, phone, line1, line2, suburb, city,
  province, postal_code, country, delivery_notes, is_default
) ON public.addresses TO authenticated;
GRANT UPDATE (
  label, recipient_name, phone, line1, line2, suburb, city, province,
  postal_code, country, delivery_notes, is_default, updated_at
) ON public.addresses TO authenticated;
GRANT DELETE ON public.addresses TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.customer_verification FROM authenticated;
GRANT INSERT (
  user_id, status, method, verified_at, verified_by, provider_reference,
  metadata
) ON public.customer_verification TO authenticated;
GRANT UPDATE (
  status, method, verified_at, verified_by, provider_reference, metadata, updated_at
) ON public.customer_verification TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated;
GRANT INSERT (user_id, role) ON public.user_roles TO authenticated;
GRANT UPDATE (role) ON public.user_roles TO authenticated;
GRANT DELETE ON public.user_roles TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Least-privilege RLS policies
-- ---------------------------------------------------------------------------

-- Profiles: customers see only their own row; budtenders can read; managers/admins
-- can update profile fields, but ownership columns are not writable.
DROP POLICY IF EXISTS "own profile select" ON public.profiles;
DROP POLICY IF EXISTS "own profile insert" ON public.profiles;
DROP POLICY IF EXISTS "own profile update" ON public.profiles;

CREATE POLICY "profiles select own or staff"
ON public.profiles FOR SELECT TO authenticated
USING (
  (SELECT auth.uid()) = id
  OR (SELECT public.has_at_least_role('budtender'::public.app_role))
);

CREATE POLICY "profiles insert self"
ON public.profiles FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = id);

CREATE POLICY "profiles update own or management"
ON public.profiles FOR UPDATE TO authenticated
USING (
  (SELECT auth.uid()) = id
  OR (SELECT public.has_at_least_role('manager'::public.app_role))
)
WITH CHECK (
  (SELECT auth.uid()) = id
  OR (SELECT public.has_at_least_role('manager'::public.app_role))
);

-- Products: active catalogue is public; staff can read inactive products;
-- only managers/admins can write catalogue data.
DROP POLICY IF EXISTS "products public read" ON public.products;

CREATE POLICY "products active public read"
ON public.products FOR SELECT TO anon, authenticated
USING (is_active);

CREATE POLICY "products staff read"
ON public.products FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));

CREATE POLICY "products management insert"
ON public.products FOR INSERT TO authenticated
WITH CHECK ((SELECT public.has_at_least_role('manager'::public.app_role)));

CREATE POLICY "products management update"
ON public.products FOR UPDATE TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)))
WITH CHECK ((SELECT public.has_at_least_role('manager'::public.app_role)));

CREATE POLICY "products management delete"
ON public.products FOR DELETE TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)));

-- Orders: customers see/create their own orders; staff can read/update operationally.
DROP POLICY IF EXISTS "own orders select" ON public.orders;
DROP POLICY IF EXISTS "own orders insert" ON public.orders;

CREATE POLICY "orders select own or staff"
ON public.orders FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT public.has_at_least_role('budtender'::public.app_role))
);

CREATE POLICY "orders insert self"
ON public.orders FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "orders update staff"
ON public.orders FOR UPDATE TO authenticated
USING ((SELECT public.has_at_least_role('budtender'::public.app_role)))
WITH CHECK ((SELECT public.has_at_least_role('budtender'::public.app_role)));

-- Order items: customers can only add items to their own order, and prices/names
-- must match the referenced active product; staff can read operationally.
DROP POLICY IF EXISTS "own order items select" ON public.order_items;
DROP POLICY IF EXISTS "own order items insert" ON public.order_items;

CREATE POLICY "order items select own or staff"
ON public.order_items FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.orders AS o
    WHERE o.id = order_id
      AND (
        o.user_id = (SELECT auth.uid())
        OR (SELECT public.has_at_least_role('budtender'::public.app_role))
      )
  )
);

CREATE POLICY "order items insert own validated product"
ON public.order_items FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.orders AS o
    WHERE o.id = order_id
      AND o.user_id = (SELECT auth.uid())
  )
  AND product_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.products AS p
    WHERE p.id = product_id
      AND p.is_active
      AND p.name = product_name
      AND p.price_rand = unit_price_rand
  )
);

-- User roles: users can only read themselves; only admins can mutate role
-- assignments. This prevents self-escalation.
DROP POLICY IF EXISTS "Users can read own roles" ON public.user_roles;

CREATE POLICY "user roles select own or management"
ON public.user_roles FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT public.has_at_least_role('manager'::public.app_role))
);

CREATE POLICY "user roles admin insert"
ON public.user_roles FOR INSERT TO authenticated
WITH CHECK ((SELECT public.has_at_least_role('admin'::public.app_role)));

CREATE POLICY "user roles admin update"
ON public.user_roles FOR UPDATE TO authenticated
USING ((SELECT public.has_at_least_role('admin'::public.app_role)))
WITH CHECK ((SELECT public.has_at_least_role('admin'::public.app_role)));

CREATE POLICY "user roles admin delete"
ON public.user_roles FOR DELETE TO authenticated
USING ((SELECT public.has_at_least_role('admin'::public.app_role)));

-- Addresses: customers are isolated by user_id; management can operate them.
ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "addresses select own or staff"
ON public.addresses FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT public.has_at_least_role('budtender'::public.app_role))
);

CREATE POLICY "addresses insert self"
ON public.addresses FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "addresses update own or management"
ON public.addresses FOR UPDATE TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT public.has_at_least_role('manager'::public.app_role))
)
WITH CHECK (
  user_id = (SELECT auth.uid())
  OR (SELECT public.has_at_least_role('manager'::public.app_role))
);

CREATE POLICY "addresses delete own or management"
ON public.addresses FOR DELETE TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT public.has_at_least_role('manager'::public.app_role))
);

-- Customer verification: customers can see their own verification state;
-- management controls writes; budtenders can read.
ALTER TABLE public.customer_verification ENABLE ROW LEVEL SECURITY;

CREATE POLICY "verification select own or staff"
ON public.customer_verification FOR SELECT TO authenticated
USING (
  user_id = (SELECT auth.uid())
  OR (SELECT public.has_at_least_role('budtender'::public.app_role))
);

CREATE POLICY "verification management insert"
ON public.customer_verification FOR INSERT TO authenticated
WITH CHECK ((SELECT public.has_at_least_role('manager'::public.app_role)));

CREATE POLICY "verification management update"
ON public.customer_verification FOR UPDATE TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)))
WITH CHECK ((SELECT public.has_at_least_role('manager'::public.app_role)));

-- Audit log: immutable to authenticated users; managers/admins can read.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit log management read"
ON public.audit_log FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)));

-- Ensure operational tables remain RLS-protected.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 7. New-user bootstrap
-- ---------------------------------------------------------------------------

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

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'customer'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

COMMIT;
