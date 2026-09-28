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
  WHERE product_price_history.product_id = product_id;

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
END $$;
