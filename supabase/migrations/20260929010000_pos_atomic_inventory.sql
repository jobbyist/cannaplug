-- Milestone 3: POS & atomic inventory.
--
-- Design (see CANNAPLUG.md "Milestone 3"):
--   * ONE inventory engine. inventory_batches + inventory_ledger (Milestone 2) remain the only
--     stock store. inventory_ledger is the immutable stock_movements table (view provided).
--   * inventory_batches gains lock-protected counters qty_on_hand / qty_held. A trigger keeps
--     qty_on_hand equal to SUM(ledger.quantity_delta); reservations keep qty_held equal to the
--     sum of HELD reservations. CHECK constraints make negative stock and over-holding impossible
--     even if application code is wrong:  0 <= qty_held <= qty_on_hand.
--   * available = qty_on_hand - qty_held; held = active reservations; consumed = net sale movements.
--   * Locking discipline (deadlock freedom): every code path locks inventory_batches rows FIRST,
--     in one global order (product_id, expires_at NULLS LAST, received_at, id), and only then
--     touches reservations / ledger rows. Order rows are locked before batches; sessions before
--     sales are created; sales before sessions when voiding/refunding.
--   * Idempotency: operation_idempotency (per actor + key, request-hash checked) plus unique
--     indexes on sales, refunds, tender references, payment events, loyalty entries and per-line
--     stock movements. Every mutating RPC requires READ COMMITTED.
--   * No client-controlled prices, totals or stock values: RPCs take product ids and quantities
--     only, price from products, and re-derive every total server-side.

-- ---------------------------------------------------------------------------
-- 0. Fix latent Milestone 2 defect (found by supabase/tests/milestone2_live_admin.sql on a fresh DB):
--    changing a price twice inside ONE transaction closes the open interval at now(), which equals
--    its own start, and the strict CHECK (effective_to > effective_from) rejected the UPDATE.
--    A price superseded within the same instant is a legitimate zero-length interval.
-- ---------------------------------------------------------------------------

ALTER TABLE public.product_price_history DROP CONSTRAINT product_price_history_range_chk;
ALTER TABLE public.product_price_history
  ADD CONSTRAINT product_price_history_range_chk CHECK (effective_to IS NULL OR effective_to >= effective_from);

-- ---------------------------------------------------------------------------
-- 1. Extend the existing batch / ledger tables (no second engine)
-- ---------------------------------------------------------------------------

ALTER TABLE public.inventory_batches
  ADD COLUMN qty_on_hand integer NOT NULL DEFAULT 0,
  ADD COLUMN qty_held integer NOT NULL DEFAULT 0;

UPDATE public.inventory_batches b
SET qty_on_hand = s.total
FROM (
  SELECT batch_id, SUM(quantity_delta)::integer AS total
  FROM public.inventory_ledger
  GROUP BY batch_id
) s
WHERE s.batch_id = b.id;

ALTER TABLE public.inventory_batches
  ADD CONSTRAINT inventory_batches_on_hand_nonneg CHECK (qty_on_hand >= 0),
  ADD CONSTRAINT inventory_batches_held_nonneg CHECK (qty_held >= 0),
  ADD CONSTRAINT inventory_batches_held_lte_on_hand CHECK (qty_held <= qty_on_hand);

CREATE INDEX inventory_batches_product_fefo_idx
  ON public.inventory_batches (product_id, expires_at NULLS LAST, received_at, id);

-- movement_type is added without an UPDATE (ledger is append-only) and its default is removed so
-- every writer must state intent.
ALTER TABLE public.inventory_ledger
  ADD COLUMN movement_type text NOT NULL DEFAULT 'adjustment';
ALTER TABLE public.inventory_ledger ALTER COLUMN movement_type DROP DEFAULT;

ALTER TABLE public.inventory_ledger
  ADD CONSTRAINT inventory_ledger_movement_type_chk CHECK (
    movement_type IN (
      'receipt', 'adjustment', 'online_sale', 'online_cancel_restock',
      'pos_sale', 'pos_void_restock', 'pos_refund_restock'
    )
  ),
  ADD CONSTRAINT inventory_ledger_sign_chk CHECK (
    (movement_type IN ('online_sale', 'pos_sale') AND quantity_delta < 0)
    OR (movement_type IN ('receipt', 'online_cancel_restock', 'pos_void_restock', 'pos_refund_restock') AND quantity_delta > 0)
    OR movement_type = 'adjustment'
  );

-- A given business line can move a given batch at most once per movement type:
-- duplicate requests / retries cannot double-deduct or double-restock.
CREATE UNIQUE INDEX inventory_ledger_reference_uidx
  ON public.inventory_ledger (movement_type, reference_type, reference_id, batch_id)
  WHERE reference_id IS NOT NULL;

CREATE INDEX inventory_ledger_reference_idx
  ON public.inventory_ledger (reference_type, reference_id);

CREATE OR REPLACE FUNCTION public._apply_ledger_to_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Row-level UPDATE takes the batch lock; CHECK constraints reject negative stock.
  UPDATE public.inventory_batches
  SET qty_on_hand = qty_on_hand + NEW.quantity_delta
  WHERE id = NEW.batch_id AND product_id = NEW.product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger_batch_mismatch: batch % does not belong to product %', NEW.batch_id, NEW.product_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER inventory_ledger_apply
AFTER INSERT ON public.inventory_ledger
FOR EACH ROW EXECUTE FUNCTION public._apply_ledger_to_batch();

-- ---------------------------------------------------------------------------
-- 2. Reservations (held quantities)
-- ---------------------------------------------------------------------------

CREATE TABLE public.stock_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.inventory_batches(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'consumed', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT stock_reservations_resolved_chk CHECK ((status = 'held') = (resolved_at IS NULL))
);

-- One live (held/consumed) reservation per order line and batch.
CREATE UNIQUE INDEX stock_reservations_live_uidx
  ON public.stock_reservations (order_item_id, batch_id) WHERE status IN ('held', 'consumed');
CREATE INDEX stock_reservations_order_idx ON public.stock_reservations (order_id, status);
CREATE INDEX stock_reservations_held_expiry_idx
  ON public.stock_reservations (expires_at) WHERE status = 'held';
CREATE INDEX stock_reservations_batch_held_idx
  ON public.stock_reservations (batch_id) WHERE status = 'held';
CREATE INDEX stock_reservations_product_idx ON public.stock_reservations (product_id);

CREATE OR REPLACE FUNCTION public._reservation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock reservations are append-only';
  END IF;
  IF OLD.status <> 'held' THEN
    RAISE EXCEPTION 'reservation already resolved (%)', OLD.status;
  END IF;
  IF NEW.status = 'held'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'reservations may only transition from held to consumed/released/expired';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_reservations_guard
BEFORE UPDATE OR DELETE ON public.stock_reservations
FOR EACH ROW EXECUTE FUNCTION public._reservation_guard();

CREATE OR REPLACE FUNCTION public._reservation_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'held' THEN
      RAISE EXCEPTION 'reservations must be inserted as held';
    END IF;
    UPDATE public.inventory_batches
    SET qty_held = qty_held + NEW.quantity
    WHERE id = NEW.batch_id AND product_id = NEW.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reservation_batch_mismatch: batch % does not belong to product %', NEW.batch_id, NEW.product_id;
    END IF;
  ELSE
    UPDATE public.inventory_batches
    SET qty_held = qty_held - OLD.quantity
    WHERE id = OLD.batch_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER stock_reservations_apply_ins
AFTER INSERT ON public.stock_reservations
FOR EACH ROW EXECUTE FUNCTION public._reservation_apply();

CREATE TRIGGER stock_reservations_apply_upd
AFTER UPDATE OF status ON public.stock_reservations
FOR EACH ROW WHEN (OLD.status = 'held' AND NEW.status <> 'held')
EXECUTE FUNCTION public._reservation_apply();

-- ---------------------------------------------------------------------------
-- 3. Read models: stock_movements + availability
-- ---------------------------------------------------------------------------

CREATE VIEW public.stock_movements WITH (security_invoker = on) AS
SELECT id, batch_id, product_id, movement_type, quantity_delta, reason,
       reference_type, reference_id, actor_user_id, created_at
FROM public.inventory_ledger;

CREATE VIEW public.inventory_availability WITH (security_invoker = on) AS
SELECT
  p.id AS product_id,
  COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()), 0)::integer AS on_hand,
  COALESCE(SUM(b.qty_held) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()), 0)::integer AS held,
  COALESCE(SUM(b.qty_on_hand - b.qty_held) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()), 0)::integer AS available,
  COALESCE(SUM(b.qty_on_hand) FILTER (WHERE b.expires_at IS NOT NULL AND b.expires_at <= now()), 0)::integer AS expired,
  COALESCE((
    SELECT -SUM(l.quantity_delta)
    FROM public.inventory_ledger l
    WHERE l.product_id = p.id
      AND l.movement_type IN ('online_sale', 'pos_sale', 'online_cancel_restock', 'pos_void_restock', 'pos_refund_restock')
  ), 0)::integer AS consumed,
  COUNT(b.id)::integer AS batches
FROM public.products p
LEFT JOIN public.inventory_batches b ON b.product_id = p.id
GROUP BY p.id;

-- ---------------------------------------------------------------------------
-- 4. Idempotency, payments, loyalty
-- ---------------------------------------------------------------------------

CREATE TABLE public.operation_idempotency (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE TABLE public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('paypal', 'card', 'eft', 'manual')),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 4 AND 200),
  order_id uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  amount numeric(10,2),
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX payment_events_order_idx ON public.payment_events (order_id);

CREATE TABLE public.loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sale_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('pos_sale', 'pos_sale_void', 'pos_refund')),
  source_id uuid NOT NULL,
  points integer NOT NULL CHECK (points <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)
);
CREATE INDEX loyalty_ledger_user_idx ON public.loyalty_ledger (user_id, created_at DESC);
CREATE INDEX loyalty_ledger_sale_idx ON public.loyalty_ledger (sale_id);

-- ---------------------------------------------------------------------------
-- 5. Cash drawers, POS sessions, sales, tenders, refunds
-- ---------------------------------------------------------------------------

CREATE TABLE public.cash_drawers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  location text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.pos_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drawer_id uuid NOT NULL REFERENCES public.cash_drawers(id) ON DELETE RESTRICT,
  opened_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float numeric(10,2) NOT NULL CHECK (opening_float >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  closed_at timestamptz,
  expected_cash numeric(10,2),
  actual_cash numeric(10,2) CHECK (actual_cash IS NULL OR actual_cash >= 0),
  variance numeric(10,2),
  tender_totals jsonb,
  sales_count integer,
  close_note text,
  approval_status text NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  approved_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  approval_note text,
  CONSTRAINT pos_sessions_closed_chk CHECK (
    status = 'open'
    OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND expected_cash IS NOT NULL
        AND actual_cash IS NOT NULL AND variance IS NOT NULL)
  ),
  CONSTRAINT pos_sessions_approval_chk CHECK (
    approval_status IN ('not_required', 'pending') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

-- Exactly one open session per drawer (till).
CREATE UNIQUE INDEX pos_sessions_one_open_per_drawer_uidx
  ON public.pos_sessions (drawer_id) WHERE status = 'open';
CREATE INDEX pos_sessions_opened_by_idx ON public.pos_sessions (opened_by, opened_at DESC);
CREATE INDEX pos_sessions_approval_idx ON public.pos_sessions (approval_status) WHERE approval_status = 'pending';

CREATE SEQUENCE public.pos_receipt_seq;

CREATE TABLE public.pos_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text NOT NULL UNIQUE,
  session_id uuid NOT NULL REFERENCES public.pos_sessions(id) ON DELETE RESTRICT,
  cashier_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  customer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'voided', 'partially_refunded', 'refunded')),
  subtotal numeric(10,2) NOT NULL CHECK (subtotal > 0),
  total numeric(10,2) NOT NULL CHECK (total > 0),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  void_reason text,
  CONSTRAINT pos_sales_total_chk CHECK (total = subtotal),
  CONSTRAINT pos_sales_void_chk CHECK ((status = 'voided') = (voided_at IS NOT NULL))
);
CREATE INDEX pos_sales_session_idx ON public.pos_sales (session_id, created_at DESC);
CREATE INDEX pos_sales_customer_idx ON public.pos_sales (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX pos_sales_cashier_idx ON public.pos_sales (cashier_id, created_at DESC);

CREATE TABLE public.pos_sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.pos_sales(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  product_name text NOT NULL,
  unit_price_rand numeric(10,2) NOT NULL CHECK (unit_price_rand >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  line_total numeric(10,2) NOT NULL,
  refunded_quantity integer NOT NULL DEFAULT 0,
  CONSTRAINT pos_sale_items_line_chk CHECK (line_total = unit_price_rand * quantity),
  CONSTRAINT pos_sale_items_refund_chk CHECK (refunded_quantity BETWEEN 0 AND quantity),
  UNIQUE (sale_id, product_id)
);
CREATE INDEX pos_sale_items_product_idx ON public.pos_sale_items (product_id);

CREATE TABLE public.pos_tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.pos_sales(id) ON DELETE RESTRICT,
  method text NOT NULL CHECK (method IN ('cash', 'card', 'eft', 'paypal')),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  reference text CHECK (reference IS NULL OR length(reference) BETWEEN 4 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_tenders_reference_chk CHECK ((method = 'cash') OR reference IS NOT NULL)
);
CREATE INDEX pos_tenders_sale_idx ON public.pos_tenders (sale_id);
-- The same card slip / EFT proof / PayPal capture can never back two tenders.
CREATE UNIQUE INDEX pos_tenders_reference_uidx
  ON public.pos_tenders (method, reference) WHERE reference IS NOT NULL;

CREATE TABLE public.pos_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES public.pos_sales(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES public.pos_sessions(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  restocked boolean NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_refunds_sale_idx ON public.pos_refunds (sale_id);
CREATE INDEX pos_refunds_session_idx ON public.pos_refunds (session_id);

-- A refund is paid out per tender method (mirrors multi-tender sales); each method is capped by
-- what was tendered with it and not yet refunded.
CREATE TABLE public.pos_refund_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES public.pos_refunds(id) ON DELETE RESTRICT,
  method text NOT NULL CHECK (method IN ('cash', 'card', 'eft', 'paypal')),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  reference text CHECK (reference IS NULL OR length(reference) BETWEEN 4 AND 100)
);
CREATE INDEX pos_refund_payouts_refund_idx ON public.pos_refund_payouts (refund_id);
CREATE UNIQUE INDEX pos_refund_payouts_reference_uidx
  ON public.pos_refund_payouts (method, reference) WHERE reference IS NOT NULL;

CREATE TABLE public.pos_refund_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_id uuid NOT NULL REFERENCES public.pos_refunds(id) ON DELETE RESTRICT,
  sale_item_id uuid NOT NULL REFERENCES public.pos_sale_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  UNIQUE (refund_id, sale_item_id)
);
CREATE INDEX pos_refund_items_sale_item_idx ON public.pos_refund_items (sale_item_id);

-- ---------------------------------------------------------------------------
-- 6. Immutability + consistency guards (authoritative for every role incl. service_role)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER pos_tenders_append_only BEFORE UPDATE OR DELETE ON public.pos_tenders
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER pos_refunds_append_only BEFORE UPDATE OR DELETE ON public.pos_refunds
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER pos_refund_items_append_only BEFORE UPDATE OR DELETE ON public.pos_refund_items
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER pos_refund_payouts_append_only BEFORE UPDATE OR DELETE ON public.pos_refund_payouts
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER loyalty_ledger_append_only BEFORE UPDATE OR DELETE ON public.loyalty_ledger
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER pos_sales_no_delete BEFORE DELETE ON public.pos_sales
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER pos_sale_items_no_delete BEFORE DELETE ON public.pos_sale_items
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();
CREATE TRIGGER pos_sessions_no_delete BEFORE DELETE ON public.pos_sessions
  FOR EACH ROW EXECUTE FUNCTION public._append_only_guard();

CREATE OR REPLACE FUNCTION public._pos_sale_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.cashier_id IS DISTINCT FROM OLD.cashier_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pos_sales financial columns are immutable';
  END IF;
  IF NOT (
    (OLD.status = 'completed' AND NEW.status IN ('voided', 'partially_refunded', 'refunded'))
    OR (OLD.status = 'partially_refunded' AND NEW.status IN ('partially_refunded', 'refunded'))
    OR (OLD.status = NEW.status AND OLD.voided_at IS NOT DISTINCT FROM NEW.voided_at)
  ) THEN
    RAISE EXCEPTION 'invalid pos_sales status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_sales_update_guard BEFORE UPDATE ON public.pos_sales
  FOR EACH ROW EXECUTE FUNCTION public._pos_sale_update_guard();

CREATE OR REPLACE FUNCTION public._pos_sale_item_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.product_name IS DISTINCT FROM OLD.product_name
     OR NEW.unit_price_rand IS DISTINCT FROM OLD.unit_price_rand
     OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.line_total IS DISTINCT FROM OLD.line_total
     OR NEW.refunded_quantity < OLD.refunded_quantity THEN
    RAISE EXCEPTION 'pos_sale_items snapshot columns are immutable; refunded_quantity only increases';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_sale_items_update_guard BEFORE UPDATE ON public.pos_sale_items
  FOR EACH ROW EXECUTE FUNCTION public._pos_sale_item_update_guard();

CREATE OR REPLACE FUNCTION public._pos_session_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.drawer_id IS DISTINCT FROM OLD.drawer_id
     OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.opening_float IS DISTINCT FROM OLD.opening_float THEN
    RAISE EXCEPTION 'pos_sessions identity/opening columns are immutable';
  END IF;
  IF OLD.status = 'closed' AND (
       NEW.status <> 'closed'
       OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
       OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
       OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash
       OR NEW.actual_cash IS DISTINCT FROM OLD.actual_cash
       OR NEW.variance IS DISTINCT FROM OLD.variance
       OR NEW.tender_totals IS DISTINCT FROM OLD.tender_totals
       OR NEW.sales_count IS DISTINCT FROM OLD.sales_count
       OR NEW.close_note IS DISTINCT FROM OLD.close_note) THEN
    RAISE EXCEPTION 'a closed pos_session count is immutable';
  END IF;
  IF OLD.approval_status IN ('approved', 'rejected') AND NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    RAISE EXCEPTION 'session approval decision is final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pos_sessions_update_guard BEFORE UPDATE ON public.pos_sessions
  FOR EACH ROW EXECUTE FUNCTION public._pos_session_update_guard();

-- Deferred (commit-time) backstop: whatever wrote the sale, its tenders and stock movements must
-- reconcile exactly to the sale total and line quantities.
CREATE OR REPLACE FUNCTION public._check_pos_sale_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_items numeric(10,2);
  v_tenders numeric(10,2);
  v_bad integer;
BEGIN
  SELECT COALESCE(SUM(line_total), 0) INTO v_items FROM public.pos_sale_items WHERE sale_id = NEW.id;
  SELECT COALESCE(SUM(amount), 0) INTO v_tenders FROM public.pos_tenders WHERE sale_id = NEW.id;
  IF v_items <> NEW.total THEN
    RAISE EXCEPTION 'sale_total_mismatch: items % <> total %', v_items, NEW.total;
  END IF;
  IF v_tenders <> NEW.total THEN
    RAISE EXCEPTION 'tender_mismatch: tenders % <> total %', v_tenders, NEW.total;
  END IF;
  SELECT COUNT(*) INTO v_bad
  FROM public.pos_sale_items i
  WHERE i.sale_id = NEW.id
    AND i.quantity <> COALESCE((
      SELECT -SUM(l.quantity_delta) FROM public.inventory_ledger l
      WHERE l.movement_type = 'pos_sale' AND l.reference_type = 'pos_sale_item' AND l.reference_id = i.id
    ), 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'stock_mismatch: % sale line(s) have no matching stock movement', v_bad;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER pos_sales_consistency
AFTER INSERT ON public.pos_sales
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public._check_pos_sale_consistency();

-- ---------------------------------------------------------------------------
-- 7. Internal helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._require_read_committed()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'isolation_level: inventory/POS functions require READ COMMITTED (got %)', current_setting('transaction_isolation');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public._assert_staff(p_actor uuid, p_min public.app_role)
RETURNS public.app_role
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role public.app_role;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'forbidden: actor required' USING ERRCODE = '42501';
  END IF;
  SELECT ur.role INTO v_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_actor
  ORDER BY public.role_level(ur.role) DESC
  LIMIT 1;
  IF v_role IS NULL OR public.role_level(v_role) < public.role_level(p_min) THEN
    RAISE EXCEPTION 'forbidden: % access required', p_min USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END;
$$;

CREATE OR REPLACE FUNCTION public._audit(
  p_actor uuid, p_action text, p_entity_type text, p_entity_id uuid, p_metadata jsonb
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (p_actor, p_action, p_entity_type, p_entity_id, COALESCE(p_metadata, '{}'::jsonb));
$$;

-- Returns NULL when the caller owns the operation (proceed) or the stored response for a replay.
-- A concurrent duplicate blocks on the unique index until the first transaction finishes.
CREATE OR REPLACE FUNCTION public._idem_begin(p_scope text, p_actor uuid, p_key text, p_request jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key text;
  v_hash text := encode(sha256(convert_to(COALESCE(p_request::text, ''), 'utf8')), 'hex');
  v_row public.operation_idempotency;
BEGIN
  IF p_key IS NULL OR length(p_key) < 8 OR length(p_key) > 128 THEN
    RAISE EXCEPTION 'idempotency_key_required: supply a unique key of 8-128 characters';
  END IF;
  v_key := p_actor::text || ':' || p_key;
  INSERT INTO public.operation_idempotency (scope, key, request_hash)
  VALUES (p_scope, v_key, v_hash)
  ON CONFLICT (scope, key) DO NOTHING;
  IF FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_row FROM public.operation_idempotency WHERE scope = p_scope AND key = v_key;
  IF v_row.request_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_conflict: key was already used with a different request';
  END IF;
  RETURN v_row.response;
END;
$$;

CREATE OR REPLACE FUNCTION public._idem_finish(p_scope text, p_actor uuid, p_key text, p_response jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.operation_idempotency SET response = p_response
  WHERE scope = p_scope AND key = p_actor::text || ':' || p_key
  RETURNING p_response;
$$;

-- Locks batches in the single global order used by every code path.
CREATE OR REPLACE FUNCTION public._lock_batches(p_batch_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_batch_ids IS NULL OR cardinality(p_batch_ids) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1
  FROM public.inventory_batches b
  WHERE b.id = ANY (p_batch_ids)
  ORDER BY b.product_id, b.expires_at NULLS LAST, b.received_at, b.id
  FOR UPDATE;
END;
$$;

-- Expires overdue holds. Batches are locked first (global order), then reservations resolved.
CREATE OR REPLACE FUNCTION public._expire_holds(p_product_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batches uuid[];
  v_n integer;
BEGIN
  SELECT array_agg(DISTINCT r.batch_id) INTO v_batches
  FROM public.stock_reservations r
  WHERE r.status = 'held' AND r.expires_at < now()
    AND (p_product_id IS NULL OR r.product_id = p_product_id);
  IF v_batches IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM public._lock_batches(v_batches);
  UPDATE public.stock_reservations
  SET status = 'expired', resolved_at = now()
  WHERE status = 'held' AND expires_at < now() AND batch_id = ANY (v_batches);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- First-expiry-first-out allocation of AVAILABLE (on hand minus held) stock. Locks batches in the
-- global order; raises insufficient_stock (rolling the whole transaction back) when short.
CREATE OR REPLACE FUNCTION public._allocate_fefo(p_product_id uuid, p_quantity integer)
RETURNS TABLE (o_batch_id uuid, o_quantity integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_remaining integer := p_quantity;
  v_avail integer;
  v_take integer;
  r record;
BEGIN
  FOR r IN
    SELECT b.id
    FROM public.inventory_batches b
    WHERE b.product_id = p_product_id
      AND (b.expires_at IS NULL OR b.expires_at > now())
    ORDER BY b.expires_at NULLS LAST, b.received_at, b.id
    FOR UPDATE
  LOOP
    -- Re-read under the lock: never trust values captured before the lock was granted.
    SELECT b.qty_on_hand - b.qty_held INTO v_avail FROM public.inventory_batches b WHERE b.id = r.id;
    v_take := LEAST(v_remaining, GREATEST(v_avail, 0));
    IF v_take > 0 THEN
      o_batch_id := r.id;
      o_quantity := v_take;
      RETURN NEXT;
      v_remaining := v_remaining - v_take;
    END IF;
  END LOOP;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'insufficient_stock: product % requested % available %',
      p_product_id, p_quantity, p_quantity - v_remaining;
  END IF;
END;
$$;

-- Ensures every order line is fully held or consumed. Idempotent; caller must hold the order lock.
CREATE OR REPLACE FUNCTION public._reserve_order_items(p_order_id uuid, p_ttl_minutes integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item record;
  v_needed integer;
  v_alloc record;
  v_added integer := 0;
BEGIN
  FOR v_item IN
    SELECT oi.id, oi.product_id, oi.quantity
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id AND oi.product_id IS NOT NULL
    ORDER BY oi.product_id, oi.id
  LOOP
    PERFORM public._expire_holds(v_item.product_id);
    SELECT v_item.quantity - COALESCE(SUM(r.quantity), 0) INTO v_needed
    FROM public.stock_reservations r
    WHERE r.order_item_id = v_item.id AND r.status IN ('held', 'consumed');
    IF v_needed > 0 THEN
      FOR v_alloc IN SELECT * FROM public._allocate_fefo(v_item.product_id, v_needed) LOOP
        INSERT INTO public.stock_reservations
          (order_id, order_item_id, product_id, batch_id, quantity, expires_at)
        VALUES
          (p_order_id, v_item.id, v_item.product_id, v_alloc.o_batch_id, v_alloc.o_quantity,
           now() + make_interval(mins => p_ttl_minutes));
        v_added := v_added + v_alloc.o_quantity;
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_added;
END;
$$;

-- Held -> consumed (stock leaves). Batches first, then reservations; held is reduced BEFORE
-- on_hand so 0 <= held <= on_hand always holds between statements.
CREATE OR REPLACE FUNCTION public._consume_order_stock(p_order_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batches uuid[];
  r record;
BEGIN
  PERFORM public._reserve_order_items(p_order_id, 30);
  SELECT array_agg(DISTINCT s.batch_id) INTO v_batches
  FROM public.stock_reservations s WHERE s.order_id = p_order_id AND s.status = 'held';
  PERFORM public._lock_batches(v_batches);
  FOR r IN
    SELECT s.* FROM public.stock_reservations s
    WHERE s.order_id = p_order_id AND s.status = 'held'
    ORDER BY s.product_id, s.batch_id, s.id
    FOR UPDATE
  LOOP
    UPDATE public.stock_reservations SET status = 'consumed', resolved_at = now() WHERE id = r.id;
    INSERT INTO public.inventory_ledger
      (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
    VALUES
      (r.batch_id, r.product_id, -r.quantity, 'Online order confirmed', 'order_item', r.order_item_id,
       p_actor, 'online_sale');
  END LOOP;
END;
$$;

-- Cancels an order's stock: holds are released; consumed stock is returned to the same batches.
CREATE OR REPLACE FUNCTION public._cancel_order_stock(p_order_id uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_batches uuid[];
  r record;
BEGIN
  SELECT array_agg(DISTINCT s.batch_id) INTO v_batches
  FROM public.stock_reservations s WHERE s.order_id = p_order_id AND s.status IN ('held', 'consumed');
  PERFORM public._lock_batches(v_batches);
  FOR r IN
    SELECT s.* FROM public.stock_reservations s
    WHERE s.order_id = p_order_id AND s.status IN ('held', 'consumed')
    ORDER BY s.product_id, s.batch_id, s.id
    FOR UPDATE
  LOOP
    IF r.status = 'held' THEN
      UPDATE public.stock_reservations SET status = 'released', resolved_at = now() WHERE id = r.id;
    ELSE
      INSERT INTO public.inventory_ledger
        (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
      VALUES
        (r.batch_id, r.product_id, r.quantity, 'Online order cancelled', 'order_item', r.order_item_id,
         p_actor, 'online_cancel_restock')
      ON CONFLICT (movement_type, reference_type, reference_id, batch_id) WHERE reference_id IS NOT NULL
      DO NOTHING;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_variance_tolerance()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$ SELECT 10.00::numeric $$;

-- ---------------------------------------------------------------------------
-- 8. Online orders: server-priced order creation, hold, payment confirmation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_online_order(
  p_user_id uuid,
  p_items jsonb,
  p_contact_name text,
  p_contact_phone text,
  p_notes text,
  p_idempotency_key text,
  p_hold_minutes integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_line record;
  v_order public.orders;
  v_total numeric(10,2) := 0;
  v_ttl integer := LEAST(GREATEST(COALESCE(p_hold_minutes, 30), 5), 120);
  v_item_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;
  -- Inventory-denial guard: one customer cannot park unlimited stock behind unpaid holds.
  IF (SELECT COUNT(DISTINCT r.order_id)
      FROM public.stock_reservations r JOIN public.orders o ON o.id = r.order_id
      WHERE o.user_id = p_user_id AND r.status = 'held' AND r.expires_at > now()) >= 5 THEN
    RAISE EXCEPTION 'too_many_open_orders: pay for or cancel an existing order before placing another';
  END IF;
  v_cached := public._idem_begin('online_order', p_user_id, p_idempotency_key,
    jsonb_build_object('items', p_items, 'name', p_contact_name, 'phone', p_contact_phone, 'notes', p_notes));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,2}$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  INSERT INTO public.orders (user_id, contact_name, contact_phone, notes, total_rand)
  VALUES (p_user_id, left(p_contact_name, 160), left(p_contact_phone, 40), left(p_notes, 1000), 0)
  RETURNING * INTO v_order;

  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
    ORDER BY 1
  LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, quantity, unit_price_rand)
    SELECT v_order.id, p.id, p.name, v_line.quantity, p.price_rand
    FROM public.products p
    WHERE p.id = v_line.product_id AND p.is_active
    RETURNING id INTO v_item_id;
    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'product_unavailable: %', v_line.product_id;
    END IF;
    v_item_id := NULL;
  END LOOP;

  SELECT SUM(oi.unit_price_rand * oi.quantity)::numeric(10,2) INTO v_total
  FROM public.order_items oi WHERE oi.order_id = v_order.id;
  UPDATE public.orders SET total_rand = v_total WHERE id = v_order.id RETURNING * INTO v_order;

  INSERT INTO public.order_status_history (order_id, from_status, to_status, actor_user_id, note)
  VALUES (v_order.id, NULL, 'awaiting_payment', p_user_id, 'Order placed');

  PERFORM public._reserve_order_items(v_order.id, v_ttl);

  v_response := jsonb_build_object(
    'order_id', v_order.id, 'order_number', v_order.order_number, 'total', v_order.total_rand,
    'status', v_order.status, 'hold_minutes', v_ttl);
  RETURN public._idem_finish('online_order', p_user_id, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_order_stock(p_order_id uuid, p_ttl_minutes integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_order public.orders;
  v_added integer;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_not_found'; END IF;
  IF v_order.status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'invalid_order_state: only awaiting_payment orders can be reserved (%)', v_order.status;
  END IF;
  v_added := public._reserve_order_items(p_order_id, LEAST(GREATEST(COALESCE(p_ttl_minutes, 30), 5), 120));
  RETURN jsonb_build_object('order_id', p_order_id, 'newly_held', v_added);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_expired_reservations()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$ SELECT public._expire_holds(NULL) $$;

-- Retention for the idempotency table. Keys only need to outlive realistic client retry windows.
CREATE OR REPLACE FUNCTION public.purge_old_idempotency_keys(p_retain interval DEFAULT interval '30 days')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_retain < interval '1 day' THEN
    RAISE EXCEPTION 'retention must be at least 1 day';
  END IF;
  DELETE FROM public.operation_idempotency WHERE created_at < now() - p_retain;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Payment confirmation (PayPal/EFT/card webhook or manual). Duplicate events are no-ops.
CREATE OR REPLACE FUNCTION public.confirm_order_payment(
  p_provider text,
  p_provider_event_id text,
  p_order_id uuid,
  p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing public.payment_events;
  v_order public.orders;
  v_outcome text;
BEGIN
  PERFORM public._require_read_committed();
  -- Serialise every delivery of the same event (and any POS tender using the same reference).
  PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || p_provider || ':' || p_provider_event_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || p_provider_event_id, 1));

  SELECT * INTO v_existing FROM public.payment_events
  WHERE provider = p_provider AND provider_event_id = p_provider_event_id;
  IF FOUND THEN
    RETURN jsonb_build_object('duplicate', true, 'outcome', v_existing.outcome, 'order_id', v_existing.order_id);
  END IF;

  IF EXISTS (SELECT 1 FROM public.pos_tenders t WHERE t.method = p_provider AND t.reference = p_provider_event_id) THEN
    RAISE EXCEPTION 'payment_reference_in_use: already recorded against a POS sale';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    v_outcome := 'order_not_found';
  ELSIF v_order.status <> 'awaiting_payment' THEN
    v_outcome := CASE WHEN v_order.status = 'cancelled' THEN 'paid_after_cancel_needs_refund' ELSE 'already_processed' END;
  ELSIF p_amount IS DISTINCT FROM v_order.total_rand THEN
    v_outcome := 'amount_mismatch';
  ELSE
    BEGIN
      PERFORM public._consume_order_stock(p_order_id, NULL);
      INSERT INTO public.order_status_history (order_id, from_status, to_status, actor_user_id, note)
      VALUES (p_order_id, 'awaiting_payment', 'confirmed', NULL, 'Payment confirmed (' || p_provider || ')');
      UPDATE public.orders SET status = 'confirmed' WHERE id = p_order_id;
      v_outcome := 'confirmed';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'insufficient_stock:%' THEN
        v_outcome := 'stock_unavailable_needs_refund';
      ELSE
        RAISE;
      END IF;
    END;
  END IF;

  INSERT INTO public.payment_events (provider, provider_event_id, order_id, amount, outcome)
  VALUES (p_provider, p_provider_event_id, CASE WHEN v_outcome = 'order_not_found' THEN NULL ELSE p_order_id END,
          p_amount, v_outcome);
  RETURN jsonb_build_object('duplicate', false, 'outcome', v_outcome, 'order_id', p_order_id);
END;
$$;

-- Manual status changes now keep stock in step with the order lifecycle (Milestone 2 signature kept).
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

  IF p_to_status = 'confirmed' AND v_order.status = 'awaiting_payment' THEN
    PERFORM public._consume_order_stock(p_order_id, p_actor_user_id);
  ELSIF p_to_status = 'cancelled' THEN
    PERFORM public._cancel_order_stock(p_order_id, p_actor_user_id);
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

-- ---------------------------------------------------------------------------
-- 9. Stock receipts and manual adjustments (audited)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.receive_stock(
  p_actor uuid,
  p_product_id uuid,
  p_batch_code text,
  p_quantity integer,
  p_expires_at timestamptz,
  p_unit_cost numeric,
  p_notes text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_batch_id uuid;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('receive_stock', p_actor, p_idempotency_key,
    jsonb_build_object('p', p_product_id, 'c', p_batch_code, 'q', p_quantity, 'e', p_expires_at, 'u', p_unit_cost));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_quantity IS NULL OR p_quantity NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_batch_code IS NULL OR length(btrim(p_batch_code)) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'invalid_batch_code'; END IF;
  IF p_unit_cost IS NOT NULL AND (p_unit_cost < 0 OR p_unit_cost <> round(p_unit_cost, 2)) THEN RAISE EXCEPTION 'invalid_unit_cost'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN RAISE EXCEPTION 'product_unavailable: %', p_product_id; END IF;

  INSERT INTO public.inventory_batches (product_id, batch_code, expires_at, unit_cost_rand, notes, created_by)
  VALUES (p_product_id, btrim(p_batch_code), p_expires_at, p_unit_cost, left(p_notes, 500), p_actor)
  ON CONFLICT (product_id, batch_code) DO NOTHING;
  SELECT id INTO v_batch_id FROM public.inventory_batches
  WHERE product_id = p_product_id AND batch_code = btrim(p_batch_code);
  PERFORM public._lock_batches(ARRAY[v_batch_id]);

  INSERT INTO public.inventory_ledger
    (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
  VALUES (v_batch_id, p_product_id, p_quantity, 'Stock received', p_actor, 'receipt');

  PERFORM public._audit(p_actor, 'stock_received', 'inventory_batch', v_batch_id,
    jsonb_build_object('product_id', p_product_id, 'batch_code', btrim(p_batch_code), 'quantity', p_quantity));
  v_response := jsonb_build_object('batch_id', v_batch_id, 'quantity', p_quantity);
  RETURN public._idem_finish('receive_stock', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_stock(
  p_actor uuid,
  p_batch_id uuid,
  p_delta integer,
  p_reason text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_batch public.inventory_batches;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('adjust_stock', p_actor, p_idempotency_key,
    jsonb_build_object('b', p_batch_id, 'd', p_delta, 'r', p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_delta IS NULL OR p_delta = 0 OR abs(p_delta) > 100000 THEN RAISE EXCEPTION 'invalid_quantity'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-300 characters is mandatory';
  END IF;

  PERFORM public._lock_batches(ARRAY[p_batch_id]);
  SELECT * INTO v_batch FROM public.inventory_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch_not_found'; END IF;
  IF p_delta < 0 AND v_batch.qty_on_hand + p_delta < v_batch.qty_held THEN
    RAISE EXCEPTION 'insufficient_stock: cannot reduce batch below held quantity (on hand %, held %, delta %)',
      v_batch.qty_on_hand, v_batch.qty_held, p_delta;
  END IF;

  INSERT INTO public.inventory_ledger
    (batch_id, product_id, quantity_delta, reason, actor_user_id, movement_type)
  VALUES (p_batch_id, v_batch.product_id, p_delta, btrim(p_reason), p_actor, 'adjustment');

  PERFORM public._audit(p_actor, 'stock_adjusted', 'inventory_batch', p_batch_id,
    jsonb_build_object('product_id', v_batch.product_id, 'delta', p_delta, 'reason', btrim(p_reason),
                       'before', v_batch.qty_on_hand, 'after', v_batch.qty_on_hand + p_delta));
  v_response := jsonb_build_object('batch_id', p_batch_id, 'before', v_batch.qty_on_hand, 'after', v_batch.qty_on_hand + p_delta);
  RETURN public._idem_finish('adjust_stock', p_actor, p_idempotency_key, v_response);
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Cash drawers and POS sessions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pos_upsert_drawer(p_actor uuid, p_drawer_id uuid, p_name text, p_location text, p_is_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  IF p_drawer_id IS NULL THEN
    INSERT INTO public.cash_drawers (name, location, is_active)
    VALUES (btrim(p_name), left(p_location, 120), COALESCE(p_is_active, true)) RETURNING id INTO v_id;
  ELSE
    UPDATE public.cash_drawers SET name = btrim(p_name), location = left(p_location, 120),
      is_active = COALESCE(p_is_active, is_active)
    WHERE id = p_drawer_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'drawer_not_found'; END IF;
  END IF;
  RETURN jsonb_build_object('drawer_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_open_session(
  p_actor uuid, p_drawer_id uuid, p_opening_float numeric, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_drawer public.cash_drawers;
  v_session public.pos_sessions;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_open_session', p_actor, p_idempotency_key,
    jsonb_build_object('d', p_drawer_id, 'f', p_opening_float));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_opening_float IS NULL OR p_opening_float < 0 OR p_opening_float > 100000
     OR p_opening_float <> round(p_opening_float, 2) THEN
    RAISE EXCEPTION 'invalid_amount: opening float must be 0-100000 with at most 2 decimals';
  END IF;
  SELECT * INTO v_drawer FROM public.cash_drawers WHERE id = p_drawer_id FOR SHARE;
  IF NOT FOUND OR NOT v_drawer.is_active THEN RAISE EXCEPTION 'drawer_unavailable'; END IF;

  BEGIN
    INSERT INTO public.pos_sessions (drawer_id, opened_by, opening_float)
    VALUES (p_drawer_id, p_actor, p_opening_float) RETURNING * INTO v_session;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'drawer_already_open: close the current session on this drawer first';
  END;

  PERFORM public._audit(p_actor, 'pos_session_opened', 'pos_session', v_session.id,
    jsonb_build_object('drawer_id', p_drawer_id, 'opening_float', p_opening_float));
  v_response := jsonb_build_object('session_id', v_session.id, 'drawer_id', p_drawer_id,
                                   'opening_float', v_session.opening_float, 'opened_at', v_session.opened_at);
  RETURN public._idem_finish('pos_open_session', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_close_session(
  p_actor uuid, p_session_id uuid, p_actual_cash numeric, p_note text, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_role public.app_role;
  v_session public.pos_sessions;
  v_cash_sales numeric(10,2);
  v_cash_refunds numeric(10,2);
  v_expected numeric(10,2);
  v_variance numeric(10,2);
  v_totals jsonb;
  v_count integer;
  v_approval text;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_close_session', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_session_id, 'a', p_actual_cash, 'n', p_note));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_actual_cash IS NULL OR p_actual_cash < 0 OR p_actual_cash > 10000000
     OR p_actual_cash <> round(p_actual_cash, 2) THEN
    RAISE EXCEPTION 'invalid_amount: counted cash must be >= 0 with at most 2 decimals';
  END IF;

  -- Exclusive lock: waits for every in-flight sale (which hold FOR SHARE) to commit, and makes any
  -- later sale see status = closed. This is what makes expected cash exact.
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
  IF v_session.opened_by <> p_actor AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'session_not_yours';
  END IF;

  SELECT COALESCE(SUM(t.amount), 0) INTO v_cash_sales
  FROM public.pos_tenders t JOIN public.pos_sales s ON s.id = t.sale_id
  WHERE s.session_id = p_session_id AND t.method = 'cash' AND s.status <> 'voided';
  SELECT COALESCE(SUM(po.amount), 0) INTO v_cash_refunds
  FROM public.pos_refund_payouts po JOIN public.pos_refunds r ON r.id = po.refund_id
  WHERE r.session_id = p_session_id AND po.method = 'cash';

  v_expected := v_session.opening_float + v_cash_sales - v_cash_refunds;
  v_variance := p_actual_cash - v_expected;

  SELECT COUNT(*) INTO v_count FROM public.pos_sales WHERE session_id = p_session_id AND status <> 'voided';
  SELECT COALESCE(jsonb_object_agg(m.method, m.net), '{}'::jsonb) INTO v_totals
  FROM (
    SELECT x.method, SUM(x.amount) AS net FROM (
      SELECT t.method, t.amount FROM public.pos_tenders t JOIN public.pos_sales s ON s.id = t.sale_id
      WHERE s.session_id = p_session_id AND s.status <> 'voided'
      UNION ALL
      SELECT po.method, -po.amount FROM public.pos_refund_payouts po JOIN public.pos_refunds r ON r.id = po.refund_id
      WHERE r.session_id = p_session_id
    ) x GROUP BY x.method
  ) m;

  v_approval := CASE WHEN abs(v_variance) > public.pos_variance_tolerance() THEN 'pending' ELSE 'not_required' END;

  UPDATE public.pos_sessions
  SET status = 'closed', closed_by = p_actor,
      -- clock_timestamp(), not now(): now() is the transaction START, which can precede the last
      -- sale this close had to wait for. This is the real close instant, after the exclusive lock.
      closed_at = clock_timestamp(),
      expected_cash = v_expected, actual_cash = p_actual_cash, variance = v_variance,
      tender_totals = v_totals, sales_count = v_count, close_note = left(p_note, 500),
      approval_status = v_approval
  WHERE id = p_session_id;

  PERFORM public._audit(p_actor, 'pos_session_closed', 'pos_session', p_session_id,
    jsonb_build_object('expected_cash', v_expected, 'actual_cash', p_actual_cash, 'variance', v_variance,
                       'approval_status', v_approval, 'sales_count', v_count));
  v_response := jsonb_build_object('session_id', p_session_id, 'expected_cash', v_expected,
    'actual_cash', p_actual_cash, 'variance', v_variance, 'tender_totals', v_totals,
    'sales_count', v_count, 'approval_status', v_approval);
  RETURN public._idem_finish('pos_close_session', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_review_session(
  p_actor uuid, p_session_id uuid, p_approve boolean, p_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.pos_sessions;
  v_status text := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF v_session.status <> 'closed' OR v_session.approval_status <> 'pending' THEN
    RAISE EXCEPTION 'not_pending: session has no pending variance approval';
  END IF;
  IF v_session.closed_by = p_actor OR v_session.opened_by = p_actor THEN
    RAISE EXCEPTION 'forbidden: variance must be approved by someone other than the cashier' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) < 3 THEN RAISE EXCEPTION 'reason_required'; END IF;

  UPDATE public.pos_sessions
  SET approval_status = v_status, approved_by = p_actor, approved_at = now(), approval_note = left(btrim(p_note), 500)
  WHERE id = p_session_id;
  PERFORM public._audit(p_actor, 'pos_session_' || v_status, 'pos_session', p_session_id,
    jsonb_build_object('variance', v_session.variance, 'note', left(btrim(p_note), 500)));
  RETURN jsonb_build_object('session_id', p_session_id, 'approval_status', v_status);
END;
$$;

-- ---------------------------------------------------------------------------
-- 11. POS sale (atomic: price, tenders, stock, all-or-nothing)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pos_complete_sale(
  p_actor uuid,
  p_session_id uuid,
  p_items jsonb,
  p_tenders jsonb,
  p_customer_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_role public.app_role;
  v_session public.pos_sessions;
  v_line record;
  v_tender record;
  v_priced jsonb := '[]'::jsonb;
  v_name text;
  v_price numeric(10,2);
  v_total numeric(10,2) := 0;
  v_tender_sum numeric(10,2) := 0;
  v_sale_id uuid := gen_random_uuid();
  v_receipt text;
  v_item_id uuid;
  v_alloc record;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  v_role := public._assert_staff(p_actor, 'budtender');
  v_cached := public._idem_begin('pos_sale', p_actor, p_idempotency_key,
    jsonb_build_object('session', p_session_id, 'items', p_items, 'tenders', p_tenders, 'customer', p_customer_id));
  IF v_cached IS NOT NULL THEN
    RETURN v_cached || jsonb_build_object('replayed', true);
  END IF;

  -- Structural validation. Only product_id + quantity are read from items: client prices are ignored.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,3}$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  IF p_tenders IS NULL OR jsonb_typeof(p_tenders) <> 'array' OR jsonb_array_length(p_tenders) NOT BETWEEN 1 AND 8
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_tenders) t
       WHERE jsonb_typeof(t) <> 'object'
          OR (t->>'method') NOT IN ('cash', 'card', 'eft', 'paypal')
          OR (t->>'amount') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
          OR (t->>'amount')::numeric <= 0
          OR ((t->>'method') = 'cash' AND (t->>'reference') IS NOT NULL)
          OR ((t->>'method') <> 'cash' AND length(COALESCE(t->>'reference', '')) NOT BETWEEN 4 AND 100)) THEN
    RAISE EXCEPTION 'invalid_tenders: method cash|card|eft|paypal, amount > 0 (max 2 decimals), non-cash needs a 4-100 char reference';
  END IF;

  -- Session: shared lock so a concurrent till close waits for this sale (and vice versa).
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed'; END IF;
  IF v_session.opened_by <> p_actor AND public.role_level(v_role) < public.role_level('manager') THEN
    RAISE EXCEPTION 'session_not_yours';
  END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'customer_not_found';
  END IF;

  -- Price every line from the database. FOR SHARE pins the price for the life of this transaction.
  FOR v_line IN
    SELECT (e->>'product_id')::uuid AS product_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e
    GROUP BY 1
    ORDER BY 1
  LOOP
    SELECT p.name, p.price_rand INTO v_name, v_price
    FROM public.products p WHERE p.id = v_line.product_id AND p.is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'product_unavailable: %', v_line.product_id; END IF;
    v_total := v_total + v_price * v_line.quantity;
    v_priced := v_priced || jsonb_build_array(jsonb_build_object(
      'product_id', v_line.product_id, 'name', v_name, 'unit_price', v_price,
      'quantity', v_line.quantity, 'item_id', gen_random_uuid()));
  END LOOP;

  -- Server-side tender validation: sum(tenders) must equal the server-computed total exactly.
  SELECT COALESCE(SUM((t->>'amount')::numeric), 0) INTO v_tender_sum FROM jsonb_array_elements(p_tenders) t;
  IF v_tender_sum <> v_total THEN
    RAISE EXCEPTION 'tender_mismatch: tendered % but sale total is %', v_tender_sum, v_total;
  END IF;

  -- Serialise use of external payment references (also against webhook-confirmed orders).
  FOR v_tender IN
    SELECT DISTINCT (t->>'method') AS method, (t->>'reference') AS reference
    FROM jsonb_array_elements(p_tenders) t WHERE (t->>'reference') IS NOT NULL
    ORDER BY 2, 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || v_tender.method || ':' || v_tender.reference, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('payref:' || v_tender.reference, 1));
    IF EXISTS (SELECT 1 FROM public.pos_tenders x WHERE x.method = v_tender.method AND x.reference = v_tender.reference)
       OR EXISTS (SELECT 1 FROM public.payment_events pe WHERE pe.provider = v_tender.method AND pe.provider_event_id = v_tender.reference) THEN
      RAISE EXCEPTION 'payment_reference_in_use: % reference % was already recorded', v_tender.method, v_tender.reference;
    END IF;
  END LOOP;

  v_receipt := 'POS-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('public.pos_receipt_seq')::text, 6, '0');
  INSERT INTO public.pos_sales (id, receipt_number, session_id, cashier_id, customer_id, subtotal, total, idempotency_key)
  VALUES (v_sale_id, v_receipt, p_session_id, p_actor, p_customer_id, v_total, v_total,
          p_actor::text || ':' || p_idempotency_key);

  FOR v_tender IN SELECT (t->>'method') AS method, (t->>'amount')::numeric(10,2) AS amount, (t->>'reference') AS reference
                  FROM jsonb_array_elements(p_tenders) t LOOP
    INSERT INTO public.pos_tenders (sale_id, method, amount, reference)
    VALUES (v_sale_id, v_tender.method, v_tender.amount, v_tender.reference);
  END LOOP;

  FOR v_line IN
    SELECT x.product_id, x.name, x.unit_price, x.quantity, x.item_id
    FROM jsonb_to_recordset(v_priced) AS x(product_id uuid, name text, unit_price numeric, quantity integer, item_id uuid)
    ORDER BY x.product_id
  LOOP
    INSERT INTO public.pos_sale_items (id, sale_id, product_id, product_name, unit_price_rand, quantity, line_total)
    VALUES (v_line.item_id, v_sale_id, v_line.product_id, v_line.name, v_line.unit_price, v_line.quantity,
            v_line.unit_price * v_line.quantity);

    PERFORM public._expire_holds(v_line.product_id);
    FOR v_alloc IN SELECT * FROM public._allocate_fefo(v_line.product_id, v_line.quantity) LOOP
      INSERT INTO public.inventory_ledger
        (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
      VALUES
        (v_alloc.o_batch_id, v_line.product_id, -v_alloc.o_quantity, 'POS sale ' || v_receipt,
         'pos_sale_item', v_line.item_id, p_actor, 'pos_sale');
    END LOOP;
  END LOOP;

  v_response := jsonb_build_object(
    'sale_id', v_sale_id, 'receipt_number', v_receipt, 'total', v_total, 'session_id', p_session_id,
    'customer_id', p_customer_id,
    'items', (SELECT jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                'quantity', i.quantity, 'unit_price', i.unit_price_rand, 'line_total', i.line_total) ORDER BY i.product_name)
              FROM public.pos_sale_items i WHERE i.sale_id = v_sale_id),
    'tenders', (SELECT jsonb_agg(jsonb_build_object('method', t.method, 'amount', t.amount, 'reference', t.reference) ORDER BY t.created_at, t.id)
                FROM public.pos_tenders t WHERE t.sale_id = v_sale_id));
  RETURN public._idem_finish('pos_sale', p_actor, p_idempotency_key, v_response);
END;
$$;

-- ---------------------------------------------------------------------------
-- 12. Voids, refunds, loyalty (all audited)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pos_void_sale(p_actor uuid, p_sale_id uuid, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_sale public.pos_sales;
  v_session public.pos_sessions;
  v_batches uuid[];
  v_mv record;
  v_current integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('pos_void', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_sale_id, 'r', p_reason));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-500 characters is mandatory';
  END IF;

  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale_not_found'; END IF;
  IF v_sale.status <> 'completed' THEN
    RAISE EXCEPTION 'invalid_sale_state: only completed, unrefunded sales can be voided (%)', v_sale.status;
  END IF;
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = v_sale.session_id FOR SHARE;
  IF v_session.status <> 'open' THEN
    RAISE EXCEPTION 'session_closed: the sale''s till session is closed; issue a refund instead';
  END IF;

  SELECT array_agg(DISTINCT l.batch_id) INTO v_batches
  FROM public.inventory_ledger l
  JOIN public.pos_sale_items i ON i.id = l.reference_id AND l.reference_type = 'pos_sale_item'
  WHERE i.sale_id = p_sale_id AND l.movement_type = 'pos_sale';
  PERFORM public._lock_batches(v_batches);

  FOR v_mv IN
    SELECT l.batch_id, l.product_id, -l.quantity_delta AS qty, l.reference_id
    FROM public.inventory_ledger l
    JOIN public.pos_sale_items i ON i.id = l.reference_id AND l.reference_type = 'pos_sale_item'
    WHERE i.sale_id = p_sale_id AND l.movement_type = 'pos_sale'
    ORDER BY l.product_id, l.batch_id, l.id
  LOOP
    INSERT INTO public.inventory_ledger
      (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
    VALUES
      (v_mv.batch_id, v_mv.product_id, v_mv.qty, 'POS void ' || v_sale.receipt_number,
       'pos_sale_item', v_mv.reference_id, p_actor, 'pos_void_restock');
  END LOOP;

  UPDATE public.pos_sales
  SET status = 'voided', voided_at = now(), voided_by = p_actor, void_reason = btrim(p_reason)
  WHERE id = p_sale_id;

  SELECT COALESCE(SUM(points), 0) INTO v_current FROM public.loyalty_ledger WHERE sale_id = p_sale_id;
  IF v_current > 0 THEN
    INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
    VALUES (v_sale.customer_id, p_sale_id, 'pos_sale_void', p_sale_id, -v_current)
    ON CONFLICT (source_type, source_id) DO NOTHING;
  END IF;

  PERFORM public._audit(p_actor, 'pos_sale_voided', 'pos_sale', p_sale_id,
    jsonb_build_object('receipt', v_sale.receipt_number, 'total', v_sale.total, 'reason', btrim(p_reason),
                       'session_id', v_sale.session_id, 'loyalty_reversed', v_current));
  v_response := jsonb_build_object('sale_id', p_sale_id, 'status', 'voided', 'loyalty_reversed', v_current);
  RETURN public._idem_finish('pos_void', p_actor, p_idempotency_key, v_response);
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_refund_sale(
  p_actor uuid,
  p_sale_id uuid,
  p_session_id uuid,
  p_items jsonb,
  p_payouts jsonb,
  p_reason text,
  p_restock boolean,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_sale public.pos_sales;
  v_session public.pos_sessions;
  v_line record;
  v_item public.pos_sale_items;
  v_amount numeric(10,2) := 0;
  v_tendered numeric(10,2);
  v_refunded numeric(10,2);
  v_payout record;
  v_refund_id uuid := gen_random_uuid();
  v_batches uuid[];
  v_mv record;
  v_left integer;
  v_put integer;
  v_all_refunded boolean;
  v_target integer;
  v_current integer;
  v_response jsonb;
BEGIN
  PERFORM public._require_read_committed();
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('pos_refund', p_actor, p_idempotency_key,
    jsonb_build_object('s', p_sale_id, 'ses', p_session_id, 'i', p_items, 'm', p_payouts, 'r', p_reason, 'k', p_restock));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  IF p_payouts IS NULL OR jsonb_typeof(p_payouts) <> 'array' OR jsonb_array_length(p_payouts) NOT BETWEEN 1 AND 4
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_payouts) t
       WHERE jsonb_typeof(t) <> 'object'
          OR (t->>'method') NOT IN ('cash', 'card', 'eft', 'paypal')
          OR (t->>'amount') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
          OR (t->>'amount')::numeric <= 0
          OR ((t->>'method') = 'cash' AND (t->>'reference') IS NOT NULL)
          OR ((t->>'reference') IS NOT NULL AND length(t->>'reference') NOT BETWEEN 4 AND 100)) THEN
    RAISE EXCEPTION 'invalid_tenders: refund payouts need method cash|card|eft|paypal and amount > 0';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'reason_required: a reason of 3-500 characters is mandatory';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 100
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_items) e
       WHERE jsonb_typeof(e) <> 'object'
          OR (e->>'sale_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR (e->>'quantity') !~ '^[1-9][0-9]{0,3}$') THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;

  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale_not_found'; END IF;
  IF v_sale.status NOT IN ('completed', 'partially_refunded') THEN
    RAISE EXCEPTION 'invalid_sale_state: % sales cannot be refunded', v_sale.status;
  END IF;
  -- The refund is paid out of a currently open till session.
  SELECT * INTO v_session FROM public.pos_sessions WHERE id = p_session_id FOR SHARE;
  IF NOT FOUND OR v_session.status <> 'open' THEN RAISE EXCEPTION 'session_closed: refunds need an open till session'; END IF;

  FOR v_line IN
    SELECT (e->>'sale_item_id')::uuid AS sale_item_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e GROUP BY 1 ORDER BY 1
  LOOP
    SELECT * INTO v_item FROM public.pos_sale_items WHERE id = v_line.sale_item_id AND sale_id = p_sale_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_items: line % is not part of this sale', v_line.sale_item_id; END IF;
    IF v_item.refunded_quantity + v_line.quantity > v_item.quantity THEN
      RAISE EXCEPTION 'over_refund: % of % already refunded for %; requested %',
        v_item.refunded_quantity, v_item.quantity, v_item.product_name, v_line.quantity;
    END IF;
    v_amount := v_amount + v_item.unit_price_rand * v_line.quantity;
  END LOOP;

  -- The payouts must add up to the server-computed refund, and no method may be refunded more than
  -- was tendered with it (net of earlier refunds).
  IF (SELECT SUM((t->>'amount')::numeric) FROM jsonb_array_elements(p_payouts) t) <> v_amount THEN
    RAISE EXCEPTION 'refund_mismatch: payouts % but refund total is %',
      (SELECT SUM((t->>'amount')::numeric) FROM jsonb_array_elements(p_payouts) t), v_amount;
  END IF;
  FOR v_payout IN
    SELECT (t->>'method') AS method, SUM((t->>'amount')::numeric)::numeric(10,2) AS amount
    FROM jsonb_array_elements(p_payouts) t GROUP BY 1 ORDER BY 1
  LOOP
    SELECT COALESCE(SUM(t.amount), 0) INTO v_tendered FROM public.pos_tenders t
    WHERE t.sale_id = p_sale_id AND t.method = v_payout.method;
    SELECT COALESCE(SUM(po.amount), 0) INTO v_refunded
    FROM public.pos_refund_payouts po JOIN public.pos_refunds r ON r.id = po.refund_id
    WHERE r.sale_id = p_sale_id AND po.method = v_payout.method;
    IF v_refunded + v_payout.amount > v_tendered THEN
      RAISE EXCEPTION 'over_refund: % refund of % exceeds % tendered (already refunded %)',
        v_payout.method, v_payout.amount, v_tendered, v_refunded;
    END IF;
  END LOOP;

  IF COALESCE(p_restock, false) THEN
    SELECT array_agg(DISTINCT l.batch_id) INTO v_batches
    FROM public.inventory_ledger l
    WHERE l.reference_type = 'pos_sale_item' AND l.movement_type = 'pos_sale'
      AND l.reference_id IN (SELECT (e->>'sale_item_id')::uuid FROM jsonb_array_elements(p_items) e);
    PERFORM public._lock_batches(v_batches);
  END IF;

  INSERT INTO public.pos_refunds (id, sale_id, session_id, actor_user_id, amount, reason, restocked, idempotency_key)
  VALUES (v_refund_id, p_sale_id, p_session_id, p_actor, v_amount, btrim(p_reason), COALESCE(p_restock, false),
          p_actor::text || ':' || p_idempotency_key);
  FOR v_payout IN
    SELECT (t->>'method') AS method, (t->>'amount')::numeric(10,2) AS amount, (t->>'reference') AS reference
    FROM jsonb_array_elements(p_payouts) t
  LOOP
    INSERT INTO public.pos_refund_payouts (refund_id, method, amount, reference)
    VALUES (v_refund_id, v_payout.method, v_payout.amount, v_payout.reference);
  END LOOP;

  FOR v_line IN
    SELECT (e->>'sale_item_id')::uuid AS sale_item_id, SUM((e->>'quantity')::integer)::integer AS quantity
    FROM jsonb_array_elements(p_items) e GROUP BY 1 ORDER BY 1
  LOOP
    INSERT INTO public.pos_refund_items (refund_id, sale_item_id, quantity) VALUES (v_refund_id, v_line.sale_item_id, v_line.quantity);
    UPDATE public.pos_sale_items SET refunded_quantity = refunded_quantity + v_line.quantity WHERE id = v_line.sale_item_id;

    IF COALESCE(p_restock, false) THEN
      v_left := v_line.quantity;
      FOR v_mv IN
        SELECT l.batch_id, l.product_id, -l.quantity_delta AS qty
        FROM public.inventory_ledger l
        WHERE l.reference_type = 'pos_sale_item' AND l.reference_id = v_line.sale_item_id AND l.movement_type = 'pos_sale'
        ORDER BY l.batch_id, l.id
      LOOP
        EXIT WHEN v_left = 0;
        -- Return no more to a batch than was taken from it (net of earlier returns).
        SELECT LEAST(v_left, v_mv.qty - COALESCE((
          SELECT SUM(r.quantity_delta) FROM public.inventory_ledger r
          WHERE r.batch_id = v_mv.batch_id AND r.movement_type = 'pos_refund_restock'
            AND r.reference_type = 'pos_refund_item'
            AND r.reference_id IN (SELECT ri.id FROM public.pos_refund_items ri WHERE ri.sale_item_id = v_line.sale_item_id)), 0))
        INTO v_put;
        IF v_put > 0 THEN
          INSERT INTO public.inventory_ledger
            (batch_id, product_id, quantity_delta, reason, reference_type, reference_id, actor_user_id, movement_type)
          SELECT v_mv.batch_id, v_mv.product_id, v_put, 'POS refund ' || v_sale.receipt_number,
                 'pos_refund_item', ri.id, p_actor, 'pos_refund_restock'
          FROM public.pos_refund_items ri WHERE ri.refund_id = v_refund_id AND ri.sale_item_id = v_line.sale_item_id;
          v_left := v_left - v_put;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  SELECT bool_and(i.refunded_quantity = i.quantity) INTO v_all_refunded FROM public.pos_sale_items i WHERE i.sale_id = p_sale_id;
  UPDATE public.pos_sales SET status = CASE WHEN v_all_refunded THEN 'refunded' ELSE 'partially_refunded' END WHERE id = p_sale_id;

  -- Reverse loyalty only if it was already accrued; otherwise accrual will use the net amount.
  SELECT COALESCE(SUM(points), 0) INTO v_current FROM public.loyalty_ledger WHERE sale_id = p_sale_id;
  IF v_current > 0 THEN
    v_target := floor((v_sale.total - (SELECT COALESCE(SUM(r.amount), 0) FROM public.pos_refunds r WHERE r.sale_id = p_sale_id)) / 10)::integer;
    IF v_target < v_current THEN
      INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
      VALUES (v_sale.customer_id, p_sale_id, 'pos_refund', v_refund_id, v_target - v_current);
    END IF;
  END IF;

  PERFORM public._audit(p_actor, 'pos_sale_refunded', 'pos_sale', p_sale_id,
    jsonb_build_object('receipt', v_sale.receipt_number, 'refund_id', v_refund_id, 'amount', v_amount,
                       'payouts', p_payouts, 'reason', btrim(p_reason), 'restocked', COALESCE(p_restock, false),
                       'session_id', p_session_id));
  v_response := jsonb_build_object('refund_id', v_refund_id, 'sale_id', p_sale_id, 'amount', v_amount,
    'status', CASE WHEN v_all_refunded THEN 'refunded' ELSE 'partially_refunded' END);
  RETURN public._idem_finish('pos_refund', p_actor, p_idempotency_key, v_response);
END;
$$;

-- Idempotent loyalty accrual. Called by the application AFTER pos_complete_sale has committed
-- (never inside the sale transaction); safe to retry any number of times, concurrently.
CREATE OR REPLACE FUNCTION public.accrue_pos_loyalty(p_sale_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sale public.pos_sales;
  v_net numeric(10,2);
  v_points integer;
BEGIN
  PERFORM public._require_read_committed();
  SELECT * INTO v_sale FROM public.pos_sales WHERE id = p_sale_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('accrued', false, 'reason', 'sale_not_found'); END IF;
  IF v_sale.customer_id IS NULL THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_customer'); END IF;
  IF v_sale.status = 'voided' THEN RETURN jsonb_build_object('accrued', false, 'reason', 'voided'); END IF;
  SELECT v_sale.total - COALESCE(SUM(r.amount), 0) INTO v_net FROM public.pos_refunds r WHERE r.sale_id = p_sale_id;
  v_points := floor(v_net / 10)::integer;
  IF v_points <= 0 THEN RETURN jsonb_build_object('accrued', false, 'reason', 'no_points'); END IF;
  INSERT INTO public.loyalty_ledger (user_id, sale_id, source_type, source_id, points)
  VALUES (v_sale.customer_id, p_sale_id, 'pos_sale', p_sale_id, v_points)
  ON CONFLICT (source_type, source_id) DO NOTHING;
  IF FOUND THEN
    RETURN jsonb_build_object('accrued', true, 'points', v_points);
  END IF;
  RETURN jsonb_build_object('accrued', false, 'reason', 'already_accrued');
END;
$$;

-- ---------------------------------------------------------------------------
-- 13. Privileges and RLS
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        '_apply_ledger_to_batch', '_reservation_guard', '_reservation_apply', '_append_only_guard',
        '_pos_sale_update_guard', '_pos_sale_item_update_guard', '_pos_session_update_guard',
        '_check_pos_sale_consistency', '_require_read_committed', '_assert_staff', '_audit', '_idem_begin',
        '_idem_finish', '_lock_batches', '_expire_holds', '_allocate_fefo', '_reserve_order_items',
        '_consume_order_stock', '_cancel_order_stock', 'pos_variance_tolerance', 'create_online_order',
        'reserve_order_stock', 'release_expired_reservations', 'purge_old_idempotency_keys', 'confirm_order_payment',
        'transition_order_status', 'receive_stock', 'adjust_stock', 'pos_upsert_drawer', 'pos_open_session',
        'pos_close_session', 'pos_review_session', 'pos_complete_sale', 'pos_void_sale', 'pos_refund_sale',
        'accrue_pos_loyalty'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;

-- Prices, totals and stock are computed server-side only: customers can no longer write orders directly.
REVOKE INSERT ON public.orders FROM authenticated;
REVOKE INSERT ON public.order_items FROM authenticated;

ALTER TABLE public.stock_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operation_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_drawers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_refund_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_refund_payouts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stock_reservations, public.operation_idempotency, public.payment_events,
  public.loyalty_ledger, public.cash_drawers, public.pos_sessions, public.pos_sales,
  public.pos_sale_items, public.pos_tenders, public.pos_refunds, public.pos_refund_items, public.pos_refund_payouts,
  public.stock_movements, public.inventory_availability
  FROM anon, authenticated;
GRANT ALL ON public.stock_reservations, public.operation_idempotency, public.payment_events,
  public.loyalty_ledger, public.cash_drawers, public.pos_sessions, public.pos_sales,
  public.pos_sale_items, public.pos_tenders, public.pos_refunds, public.pos_refund_items, public.pos_refund_payouts,
  public.stock_movements, public.inventory_availability TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.pos_receipt_seq TO service_role;

GRANT SELECT ON public.stock_reservations, public.cash_drawers, public.pos_sessions, public.pos_sales,
  public.pos_sale_items, public.pos_tenders, public.stock_movements, public.inventory_availability,
  public.pos_refunds, public.pos_refund_items, public.pos_refund_payouts, public.payment_events, public.loyalty_ledger
  TO authenticated;

CREATE POLICY "staff read reservations" ON public.stock_reservations FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));
CREATE POLICY "staff read cash drawers" ON public.cash_drawers FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));
CREATE POLICY "staff read pos sessions" ON public.pos_sessions FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));
CREATE POLICY "staff read pos sales" ON public.pos_sales FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));
CREATE POLICY "staff read pos sale items" ON public.pos_sale_items FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('budtender'::public.app_role)));
CREATE POLICY "staff read pos tenders" ON public.pos_tenders FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('manager'::public.app_role)));
CREATE POLICY "staff read pos refunds" ON public.pos_refunds FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('manager'::public.app_role)));
CREATE POLICY "staff read pos refund items" ON public.pos_refund_items FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('manager'::public.app_role)));
CREATE POLICY "staff read pos refund payouts" ON public.pos_refund_payouts FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('manager'::public.app_role)));
CREATE POLICY "manager read payment events" ON public.payment_events FOR SELECT TO authenticated
  USING ((SELECT public.has_at_least_role('manager'::public.app_role)));
CREATE POLICY "own or manager read loyalty" ON public.loyalty_ledger FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.has_at_least_role('manager'::public.app_role)));

COMMENT ON TABLE public.inventory_ledger IS
  'Immutable stock_movements table. qty_on_hand on inventory_batches is maintained from it by trigger.';
COMMENT ON COLUMN public.inventory_batches.qty_held IS
  'Sum of HELD stock_reservations for the batch; maintained by triggers, bounded by qty_on_hand.';
