-- Milestone 2 regression harness.
-- Run against a disposable database or inside a transaction; no permanent fixture rows are required.

BEGIN;

DO $$
DECLARE
  v_product_id uuid;
  first_price_count integer;
  second_price_count integer;
  allowed boolean;
BEGIN
  SELECT public.order_status_transition_allowed('confirmed', 'packing') INTO allowed;
  IF NOT allowed THEN RAISE EXCEPTION 'confirmed -> packing should be allowed'; END IF;

  SELECT public.order_status_transition_allowed('packing', 'completed') INTO allowed;
  IF allowed THEN RAISE EXCEPTION 'packing -> completed must be rejected'; END IF;

  SELECT public.order_status_transition_allowed('out_for_delivery', 'completed') INTO allowed;
  IF NOT allowed THEN RAISE EXCEPTION 'out_for_delivery -> completed should be allowed'; END IF;

  SELECT public.order_status_transition_allowed('awaiting_payment', 'confirmed') INTO allowed;
  IF NOT allowed THEN RAISE EXCEPTION 'awaiting_payment -> confirmed should be allowed'; END IF;

  SELECT public.order_status_transition_allowed('completed', 'packing') INTO allowed;
  IF allowed THEN RAISE EXCEPTION 'completed -> packing must be rejected'; END IF;

  SELECT public.order_status_transition_allowed('cancelled', 'confirmed') INTO allowed;
  IF allowed THEN RAISE EXCEPTION 'cancelled -> confirmed must be rejected'; END IF;

  INSERT INTO public.products (
    slug, name, category, price_rand, is_active, sort_order
  ) VALUES (
    'test-milestone-2-price-history', 'Milestone 2 Test Product', 'Flower', 100, false, 99999
  ) RETURNING id INTO v_product_id;

  SELECT count(*) INTO first_price_count
  FROM public.product_price_history
  WHERE product_price_history.product_id = v_product_id;

  IF first_price_count < 1 THEN
    RAISE EXCEPTION 'product price history was not captured on insert';
  END IF;

  UPDATE public.products SET price_rand = 125 WHERE id = v_product_id;

  SELECT count(*) INTO second_price_count
  FROM public.product_price_history
  WHERE product_price_history.product_id = v_product_id;

  IF second_price_count < 2 THEN
    RAISE EXCEPTION 'product price history was not captured on price update';
  END IF;
END $$;

ROLLBACK;

-- Static authorization assertions.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname = 'products management update'
  ) THEN
    RAISE EXCEPTION 'manager product update policy missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname = 'products admin hard delete'
  ) THEN
    RAISE EXCEPTION 'admin-only product delete policy missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orders'
      AND policyname = 'orders select own or staff'
  ) THEN
    RAISE EXCEPTION 'order visibility policy missing';
  END IF;

  -- Customer UPDATE grants on orders are intentionally bounded by the
  -- staff-only RLS policy; staff also use the authenticated database role.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orders'
      AND policyname = 'orders update staff'
      AND qual::text ILIKE '%has_at_least_role%'
      AND qual::text ILIKE '%budtender%'
  ) THEN
    RAISE EXCEPTION 'staff-only order update policy missing or not role-gated';
  END IF;

  -- Historical order lines must not be writable after creation.
  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'authenticated'
      AND table_schema = 'public'
      AND table_name = 'order_items'
      AND privilege_type IN ('UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'authenticated order_items UPDATE/DELETE grant violates snapshot immutability';
  END IF;

  -- Manager cannot bypass admin-only physical product deletion.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname = 'products admin hard delete'
      AND qual::text ILIKE '%has_at_least_role%'
      AND qual::text ILIKE '%admin%'
  ) THEN
    RAISE EXCEPTION 'admin-only product delete policy missing or not admin-gated';
  END IF;

  -- RLS cannot protect service_role, so audit immutability must be trigger-backed.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.order_status_history'::regclass
      AND tgname = 'order_status_history_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'order status history append-only trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.product_price_history'::regclass
      AND tgname = 'product_price_history_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'product price history immutability trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.inventory_ledger'::regclass
      AND tgname = 'inventory_ledger_immutable'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'inventory ledger append-only trigger missing';
  END IF;
END $;
