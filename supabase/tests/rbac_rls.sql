\set ON_ERROR_STOP on
\if :{?customer_user_id}
\else
  \echo 'RLS_TEST_CUSTOMER_USER_ID is required'
  \quit 2
\endif
\if :{?budtender_user_id}
\else
  \echo 'RLS_TEST_BUDTENDER_USER_ID is required'
  \quit 2
\endif
\if :{?manager_user_id}
\else
  \echo 'RLS_TEST_MANAGER_USER_ID is required'
  \quit 2
\endif
\if :{?admin_user_id}
\else
  \echo 'RLS_TEST_ADMIN_USER_ID is required'
  \quit 2
\endif

BEGIN;

CREATE TEMP TABLE rbac_test_ids (
  role text PRIMARY KEY,
  user_id uuid NOT NULL
);

INSERT INTO rbac_test_ids(role, user_id) VALUES
  ('customer', :'customer_user_id'::uuid),
  ('budtender', :'budtender_user_id'::uuid),
  ('manager', :'manager_user_id'::uuid),
  ('admin', :'admin_user_id'::uuid);

DO $$
BEGIN
  IF (SELECT count(*) FROM rbac_test_ids) <> 4 THEN
    RAISE EXCEPTION 'Expected four unique test users';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN rbac_test_ids t ON t.user_id = ur.user_id
    WHERE t.role = 'customer' AND ur.role <> 'customer'
  ) THEN
    RAISE EXCEPTION 'Customer fixture has an unexpected elevated role';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'budtender')
      AND ur.role = 'budtender'
  ) THEN
    RAISE EXCEPTION 'Budtender fixture is not assigned budtender';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN rbac_test_ids t ON t.user_id = ur.user_id
    WHERE t.role = 'budtender' AND ur.role IN ('manager', 'admin')
  ) THEN
    RAISE EXCEPTION 'Budtender fixture has an unexpected elevated role';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'manager')
      AND ur.role = 'manager'
  ) THEN
    RAISE EXCEPTION 'Manager fixture is not assigned manager';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN rbac_test_ids t ON t.user_id = ur.user_id
    WHERE t.role = 'manager' AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Manager fixture has an unexpected admin role';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'admin')
      AND ur.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin fixture is not assigned admin';
  END IF;
END
$$;

-- Isolated fixtures. All writes are rolled back at the end.
INSERT INTO public.profiles (id, full_name)
SELECT user_id, 'RLS test ' || role FROM rbac_test_ids
ON CONFLICT (id) DO UPDATE
SET full_name = EXCLUDED.full_name;

INSERT INTO public.orders (id, user_id, contact_name, notes)
SELECT
  ('00000000-0000-0000-0000-' || right(md5(role), 12))::uuid,
  user_id,
  'RLS ' || role,
  'rbac-test-' || role
FROM rbac_test_ids
ON CONFLICT (id) DO UPDATE
SET user_id = EXCLUDED.user_id, contact_name = EXCLUDED.contact_name, notes = EXCLUDED.notes;

INSERT INTO public.addresses (user_id, label, line1, city, postal_code)
SELECT user_id, 'RLS Test', role || ' street', 'Pretoria', '0001'
FROM rbac_test_ids;

INSERT INTO public.customer_verification (user_id, status, metadata)
SELECT user_id, 'unverified', jsonb_build_object('fixture', true, 'role', role)
FROM rbac_test_ids
ON CONFLICT (user_id) DO UPDATE
SET status = EXCLUDED.status, metadata = EXCLUDED.metadata;

INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, target_user_id, metadata)
SELECT user_id, 'rls_test', 'rbac-test', gen_random_uuid(), user_id, jsonb_build_object('fixture', true, 'role', role)
FROM rbac_test_ids;

INSERT INTO public.products (
  id, slug, name, category, price_rand, sort_order, is_active
) VALUES
  ('00000000-0000-0000-0000-000000000901', 'rbac-test-active', 'RBAC Test Active', 'Test', 1, 1, true),
  ('00000000-0000-0000-0000-000000000902', 'rbac-test-inactive', 'RBAC Test Inactive', 'Test', 2, 2, false)
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    price_rand = EXCLUDED.price_rand,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active;

CREATE OR REPLACE FUNCTION pg_temp.assert(condition boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT condition THEN
    RAISE EXCEPTION '%', message;
  END IF;
END;
$$;

-- Customer role: own data only; no staff write/read privileges.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_id::text FROM rbac_test_ids WHERE role = 'customer'),
  true
);

SELECT pg_temp.assert(public.current_user_role() = 'customer', 'customer current_user_role failed');
SELECT pg_temp.assert(public.has_at_least_role('customer'), 'customer should have customer access');
SELECT pg_temp.assert(NOT public.has_at_least_role('budtender'), 'customer should not have budtender access');
SELECT pg_temp.assert(NOT public.has_at_least_role('manager'), 'customer should not have manager access');
SELECT pg_temp.assert(NOT public.has_at_least_role('admin'), 'customer should not have admin access');

SELECT pg_temp.assert(
  (SELECT count(*) FROM public.profiles WHERE id IN (SELECT user_id FROM rbac_test_ids)) = 1,
  'customer must only read own profile'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.orders WHERE notes LIKE 'rbac-test-%') = 1,
  'customer must only read own order'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.addresses WHERE label = 'RLS Test' AND user_id IN (SELECT user_id FROM rbac_test_ids)) = 1,
  'customer must only read own address'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.customer_verification WHERE user_id IN (SELECT user_id FROM rbac_test_ids)) = 1,
  'customer must only read own verification row'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.user_roles WHERE user_id IN (SELECT user_id FROM rbac_test_ids)) = 1,
  'customer must only read own roles'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.audit_log WHERE entity_type = 'rbac-test') = 0,
  'customer must not read audit log'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.products WHERE is_active = true AND id = '00000000-0000-0000-0000-000000000901') = 1,
  'customer should see active product'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.products WHERE is_active = false AND id = '00000000-0000-0000-0000-000000000902') = 0,
  'customer must not see inactive product'
);

UPDATE public.profiles
SET full_name = 'customer-owned-update'
WHERE id = (SELECT user_id FROM rbac_test_ids WHERE role = 'customer');
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.profiles WHERE full_name = 'customer-owned-update') = 1,
  'customer should update own profile'
);

UPDATE public.profiles
SET full_name = 'customer-cross-row'
WHERE id = (SELECT user_id FROM rbac_test_ids WHERE role = 'manager');
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.profiles WHERE full_name = 'customer-cross-row') = 0,
  'customer must not update another profile'
);

UPDATE public.products
SET name = 'customer-must-not-write'
WHERE id = '00000000-0000-0000-0000-000000000901';
SELECT pg_temp.assert(
  (SELECT name FROM public.products WHERE id = '00000000-0000-0000-0000-000000000901') = 'RBAC Test Active',
  'customer must not update products'
);

-- Budtender: read customer operational data, update orders, but no management writes.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_id::text FROM rbac_test_ids WHERE role = 'budtender'),
  true
);

SELECT pg_temp.assert(public.current_user_role() = 'budtender', 'budtender current_user_role failed');
SELECT pg_temp.assert(public.has_at_least_role('budtender'), 'budtender should have budtender access');
SELECT pg_temp.assert(NOT public.has_at_least_role('manager'), 'budtender should not have manager access');
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.profiles WHERE id IN (SELECT user_id FROM rbac_test_ids)) = 4,
  'budtender should read staff/customer profiles'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.orders WHERE notes LIKE 'rbac-test-%') = 4,
  'budtender should read all orders'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.addresses WHERE label = 'RLS Test' AND user_id IN (SELECT user_id FROM rbac_test_ids)) = 4,
  'budtender should read all addresses'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.customer_verification WHERE user_id IN (SELECT user_id FROM rbac_test_ids)) = 4,
  'budtender should read verification rows'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.audit_log WHERE entity_type = 'rbac-test') = 0,
  'budtender must not read audit log'
);
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.products WHERE is_active = false AND id = '00000000-0000-0000-0000-000000000902') = 1,
  'budtender should read inactive products'
);

UPDATE public.orders
SET status = 'processing'
WHERE notes = 'rbac-test-customer';
SELECT pg_temp.assert(
  (SELECT status FROM public.orders WHERE notes = 'rbac-test-customer') = 'processing',
  'budtender should update order status'
);

UPDATE public.products
SET name = 'budtender-must-not-write'
WHERE id = '00000000-0000-0000-0000-000000000901';
SELECT pg_temp.assert(
  (SELECT name FROM public.products WHERE id = '00000000-0000-0000-0000-000000000901') = 'RBAC Test Active',
  'budtender must not update products'
);

UPDATE public.customer_verification
SET status = 'verified'
WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'customer');
SELECT pg_temp.assert(
  (SELECT status FROM public.customer_verification WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'customer')) = 'unverified',
  'budtender must not update verification'
);

-- Manager: management access, but not role assignment.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_id::text FROM rbac_test_ids WHERE role = 'manager'),
  true
);

SELECT pg_temp.assert(public.current_user_role() = 'manager', 'manager current_user_role failed');
SELECT pg_temp.assert(public.has_at_least_role('manager'), 'manager should have manager access');
SELECT pg_temp.assert(NOT public.has_at_least_role('admin'), 'manager should not have admin access');
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.audit_log WHERE entity_type = 'rbac-test') = 4,
  'manager should read audit log'
);

UPDATE public.products
SET name = 'RBAC Manager Update'
WHERE id = '00000000-0000-0000-0000-000000000901';
SELECT pg_temp.assert(
  (SELECT name FROM public.products WHERE id = '00000000-0000-0000-0000-000000000901') = 'RBAC Manager Update',
  'manager should update products'
);

UPDATE public.customer_verification
SET status = 'verified'
WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'customer');
SELECT pg_temp.assert(
  (SELECT status FROM public.customer_verification WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'customer')) = 'verified',
  'manager should update verification'
);

UPDATE public.user_roles
SET role = 'admin'
WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'customer');
SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'customer')
      AND role = 'admin'
  ),
  'manager must not update roles'
);

-- Admin: full role-gated staff access.
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  (SELECT user_id::text FROM rbac_test_ids WHERE role = 'admin'),
  true
);

SELECT pg_temp.assert(public.current_user_role() = 'admin', 'admin current_user_role failed');
SELECT pg_temp.assert(public.has_at_least_role('customer'), 'admin should have customer access');
SELECT pg_temp.assert(public.has_at_least_role('budtender'), 'admin should have budtender access');
SELECT pg_temp.assert(public.has_at_least_role('manager'), 'admin should have manager access');
SELECT pg_temp.assert(public.has_at_least_role('admin'), 'admin should have admin access');
SELECT pg_temp.assert(
  (SELECT count(*) FROM public.audit_log WHERE entity_type = 'rbac-test') = 4,
  'admin should read audit log'
);

UPDATE public.user_roles
SET role = 'customer'
WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'admin')
  AND role = 'admin';

SELECT pg_temp.assert(
  NOT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = (SELECT user_id FROM rbac_test_ids WHERE role = 'admin')
      AND role = 'admin'
  ),
  'admin should be allowed to change role assignments'
);

ROLLBACK;
