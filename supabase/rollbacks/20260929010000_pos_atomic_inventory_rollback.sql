-- Rollback for 20260929010000_pos_atomic_inventory.sql
--
-- WARNING: destroys all Milestone 3 data (POS sessions, sales, tenders, refunds, reservations,
-- loyalty and payment-event records, idempotency keys). Stock counters revert to ledger-only
-- accounting (inventory_ledger rows are KEPT; movement_type is dropped). Take a backup first and
-- run inside a transaction on a staging copy before production.
--
-- The ledger's append-only trigger is bypassed only for the DROP COLUMN (DDL is not row mutation).

BEGIN;

-- Views and triggers first.
DROP VIEW IF EXISTS public.inventory_availability;
DROP VIEW IF EXISTS public.stock_movements;

DROP TRIGGER IF EXISTS inventory_ledger_apply ON public.inventory_ledger;
DROP TRIGGER IF EXISTS pos_sales_consistency ON public.pos_sales;

-- POS / payments / loyalty tables (children first).
DROP TABLE IF EXISTS public.pos_refund_items;
DROP TABLE IF EXISTS public.pos_refund_payouts;
DROP TABLE IF EXISTS public.pos_refunds;
DROP TABLE IF EXISTS public.pos_tenders;
DROP TABLE IF EXISTS public.pos_sale_items;
DROP TABLE IF EXISTS public.pos_sales;
DROP TABLE IF EXISTS public.pos_sessions;
DROP TABLE IF EXISTS public.cash_drawers;
DROP TABLE IF EXISTS public.loyalty_ledger;
DROP TABLE IF EXISTS public.payment_events;
DROP TABLE IF EXISTS public.operation_idempotency;
DROP TABLE IF EXISTS public.stock_reservations;
DROP SEQUENCE IF EXISTS public.pos_receipt_seq;

-- Functions.
DROP FUNCTION IF EXISTS public.accrue_missing_pos_loyalty(integer);
DROP FUNCTION IF EXISTS public.accrue_pos_loyalty(uuid);
DROP FUNCTION IF EXISTS public.pos_refund_sale(uuid, uuid, uuid, jsonb, jsonb, text, boolean, text);
DROP FUNCTION IF EXISTS public.pos_void_sale(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.pos_complete_sale(uuid, uuid, jsonb, jsonb, uuid, text);
DROP FUNCTION IF EXISTS public.pos_review_session(uuid, uuid, boolean, text);
DROP FUNCTION IF EXISTS public.pos_close_session(uuid, uuid, numeric, text, text);
DROP FUNCTION IF EXISTS public.pos_open_session(uuid, uuid, numeric, text);
DROP FUNCTION IF EXISTS public.pos_upsert_drawer(uuid, uuid, text, text, boolean);
DROP FUNCTION IF EXISTS public.adjust_stock(uuid, uuid, integer, text, text);
DROP FUNCTION IF EXISTS public.receive_stock(uuid, uuid, text, integer, timestamptz, numeric, text, text);
DROP FUNCTION IF EXISTS public.confirm_order_payment(text, text, uuid, numeric);
DROP FUNCTION IF EXISTS public.purge_old_idempotency_keys(interval);
DROP FUNCTION IF EXISTS public.release_expired_reservations();
DROP FUNCTION IF EXISTS public.reserve_order_stock(uuid, integer);
DROP FUNCTION IF EXISTS public.create_online_order(uuid, jsonb, text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.pos_variance_tolerance();
DROP FUNCTION IF EXISTS public._cancel_order_stock(uuid, uuid);
DROP FUNCTION IF EXISTS public._consume_order_stock(uuid, uuid);
DROP FUNCTION IF EXISTS public._reserve_order_items(uuid, integer);
DROP FUNCTION IF EXISTS public._allocate_fefo(uuid, integer);
DROP FUNCTION IF EXISTS public._expire_holds(uuid);
DROP FUNCTION IF EXISTS public._lock_batches(uuid[]);
DROP FUNCTION IF EXISTS public._idem_finish(text, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public._idem_begin(text, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public._audit(uuid, text, text, uuid, jsonb);
DROP FUNCTION IF EXISTS public._assert_staff(uuid, public.app_role);
DROP FUNCTION IF EXISTS public._require_read_committed();
DROP FUNCTION IF EXISTS public._check_pos_sale_consistency();
DROP FUNCTION IF EXISTS public._pos_session_update_guard();
DROP FUNCTION IF EXISTS public._pos_sale_item_update_guard();
DROP FUNCTION IF EXISTS public._pos_sale_update_guard();
DROP FUNCTION IF EXISTS public._append_only_guard();
DROP FUNCTION IF EXISTS public._reservation_apply();
DROP FUNCTION IF EXISTS public._reservation_guard();
DROP FUNCTION IF EXISTS public._apply_ledger_to_batch();

-- Restore the Milestone 2 order-transition function (no stock side effects).
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
  SELECT ur.role INTO v_role FROM public.user_roles ur
  WHERE ur.user_id = p_actor_user_id
  ORDER BY public.role_level(ur.role) DESC LIMIT 1;
  IF v_role IS NULL OR public.role_level(v_role) < public.role_level('budtender'::public.app_role) THEN
    RAISE EXCEPTION 'staff access required';
  END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order not found'; END IF;
  IF NOT public.order_status_transition_allowed(v_order.status, p_to_status) THEN
    RAISE EXCEPTION 'invalid order status transition: % -> %', v_order.status, p_to_status;
  END IF;
  INSERT INTO public.order_status_history (order_id, from_status, to_status, actor_user_id, note)
  VALUES (p_order_id, v_order.status, p_to_status, p_actor_user_id, p_note);
  UPDATE public.orders SET status = p_to_status WHERE id = p_order_id RETURNING * INTO v_order;
  RETURN v_order;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.transition_order_status(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_order_status(uuid, text, uuid, text) TO service_role;

-- Restore direct customer inserts (Milestone 2 behaviour; policies were never dropped).
GRANT INSERT ON public.orders TO authenticated;
GRANT INSERT ON public.order_items TO authenticated;

-- Ledger / batch columns and constraints.
DROP INDEX IF EXISTS public.inventory_ledger_reference_uidx;
DROP INDEX IF EXISTS public.inventory_ledger_reference_idx;
ALTER TABLE public.inventory_ledger
  DROP CONSTRAINT IF EXISTS inventory_ledger_sign_chk,
  DROP CONSTRAINT IF EXISTS inventory_ledger_movement_type_chk;
ALTER TABLE public.inventory_ledger DROP COLUMN IF EXISTS movement_type;

DROP INDEX IF EXISTS public.inventory_batches_product_fefo_idx;
ALTER TABLE public.inventory_batches
  DROP CONSTRAINT IF EXISTS inventory_batches_held_lte_on_hand,
  DROP CONSTRAINT IF EXISTS inventory_batches_held_nonneg,
  DROP CONSTRAINT IF EXISTS inventory_batches_on_hand_nonneg;
ALTER TABLE public.inventory_batches DROP COLUMN IF EXISTS qty_held, DROP COLUMN IF EXISTS qty_on_hand;

-- Milestone 2 price-history range check (strict). Fails if same-instant zero-length rows exist:
-- remove/repair those rows first.
ALTER TABLE public.product_price_history DROP CONSTRAINT IF EXISTS product_price_history_range_chk;
ALTER TABLE public.product_price_history
  ADD CONSTRAINT product_price_history_range_chk CHECK (effective_to IS NULL OR effective_to > effective_from);

COMMIT;
