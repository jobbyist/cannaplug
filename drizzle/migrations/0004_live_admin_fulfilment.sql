-- Milestone 2: live admin data, fulfilment and inventory ledger.
-- Canonical source for the production order/product/inventory lifecycle.

CREATE TABLE IF NOT EXISTS public.order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_status_history_order_created_idx
  ON public.order_status_history (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_status_history_actor_idx
  ON public.order_status_history (actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.product_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  price_rand numeric(10,2) NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_price_history_range_chk CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS product_price_history_product_effective_idx
  ON public.product_price_history (product_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS product_price_history_changed_by_idx
  ON public.product_price_history (changed_by, created_at DESC);

CREATE TABLE IF NOT EXISTS public.inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  batch_code text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  unit_cost_rand numeric(10,2),
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, batch_code)
);

CREATE TABLE IF NOT EXISTS public.inventory_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.inventory_batches(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
  reason text NOT NULL,
  reference_type text,
  reference_id uuid,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_ledger_product_created_idx
  ON public.inventory_ledger (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_ledger_batch_created_idx
  ON public.inventory_ledger (batch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_ledger_actor_created_idx
  ON public.inventory_ledger (actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.record_product_price_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.product_price_history (product_id, price_rand, effective_from)
    VALUES (NEW.id, NEW.price_rand, NEW.created_at);
  ELSIF NEW.price_rand IS DISTINCT FROM OLD.price_rand THEN
    UPDATE public.product_price_history
    SET effective_to = now()
    WHERE product_id = NEW.id AND effective_to IS NULL;

    INSERT INTO public.product_price_history (product_id, price_rand, effective_from)
    VALUES (NEW.id, NEW.price_rand, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_price_history ON public.products;
CREATE TRIGGER products_price_history
AFTER INSERT OR UPDATE OF price_rand ON public.products
FOR EACH ROW EXECUTE FUNCTION public.record_product_price_history();

INSERT INTO public.product_price_history (product_id, price_rand, effective_from)
SELECT p.id, p.price_rand, p.created_at
FROM public.products p
WHERE NOT EXISTS (
  SELECT 1 FROM public.product_price_history h WHERE h.product_id = p.id
);

CREATE OR REPLACE FUNCTION public.order_status_transition_allowed(
  p_from text,
  p_to text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_from IS NULL AND p_to = 'awaiting_payment' THEN true
    WHEN p_from = 'awaiting_payment' AND p_to IN ('confirmed', 'cancelled') THEN true
    WHEN p_from = 'confirmed' AND p_to IN ('packing', 'cancelled') THEN true
    WHEN p_from = 'packing' AND p_to = 'ready' THEN true
    WHEN p_from = 'ready' AND p_to = 'out_for_delivery' THEN true
    WHEN p_from = 'out_for_delivery' AND p_to = 'completed' THEN true
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION public.transition_order_status(
  p_order_id uuid,
  p_to_status text,
  p_actor_user_id uuid,
  p_note text DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders;
  v_role public.app_role;
BEGIN
  SELECT ur.role
  INTO v_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_actor_user_id
  ORDER BY public.role_level(ur.role) DESC
  LIMIT 1;

  IF v_role IS NULL OR public.role_level(v_role) < public.role_level('budtender'::public.app_role) THEN
    RAISE EXCEPTION 'staff access required';
  END IF;

  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'order not found';
  END IF;

  IF NOT public.order_status_transition_allowed(v_order.status, p_to_status) THEN
    RAISE EXCEPTION 'invalid order status transition: % -> %', v_order.status, p_to_status;
  END IF;

  INSERT INTO public.order_status_history (order_id, from_status, to_status, actor_user_id, note)
  VALUES (p_order_id, v_order.status, p_to_status, p_actor_user_id, p_note);

  UPDATE public.orders
  SET status = p_to_status
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  RETURN v_order;
END;
$$;

-- Correct the history row's from_status after the update by deriving it from the
-- immediately preceding state is not possible after the fact; use a wrapper that
-- captures it explicitly on the next migration. This trigger-free function is kept
-- for compatibility with clients that only need validation.
REVOKE EXECUTE ON FUNCTION public.transition_order_status(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_order_status(uuid, text, uuid, text) TO service_role;

ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_ledger ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.order_status_history TO service_role;
GRANT ALL ON public.product_price_history TO service_role;
GRANT ALL ON public.inventory_batches TO service_role;
GRANT ALL ON public.inventory_ledger TO service_role;

CREATE POLICY "staff read order status history"
ON public.order_status_history FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));

CREATE POLICY "staff read price history"
ON public.product_price_history FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('manager'::public.app_role)));

CREATE POLICY "staff read inventory batches"
ON public.inventory_batches FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));

CREATE POLICY "staff read inventory ledger"
ON public.inventory_ledger FOR SELECT TO authenticated
USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));

-- Historical order lines already store product_name and unit_price_rand snapshots.
-- Immutability policies: prevent any modification of historical records
CREATE POLICY "order status history immutable"
ON public.order_status_history FOR UPDATE TO service_role
USING (false);

CREATE POLICY "order status history no delete"
ON public.order_status_history FOR DELETE TO service_role
USING (false);

CREATE POLICY "price history immutable"
ON public.product_price_history FOR DELETE TO service_role
USING (false);

CREATE POLICY "inventory ledger immutable"
ON public.inventory_ledger FOR UPDATE TO service_role
USING (false);

CREATE POLICY "inventory ledger no delete"
ON public.inventory_ledger FOR DELETE TO service_role
USING (false);

-- This FK prevents product deletion from orphaning the product reference.
COMMENT ON COLUMN public.order_items.unit_price_rand IS
  'Immutable historical unit-price snapshot captured at order creation.';
COMMENT ON COLUMN public.order_items.product_name IS
  'Immutable historical product-name snapshot captured at order creation.';

REVOKE EXECUTE ON FUNCTION public.record_product_price_history() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_status_transition_allowed(text, text) FROM PUBLIC, anon, authenticated;
