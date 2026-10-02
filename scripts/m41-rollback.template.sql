-- Rollback for the checkout migration (20260930002000_checkout_orders.sql).
-- Orders already placed keep their rows; the delivery/payment columns on them are dropped (the address
-- snapshot is lost) — export them first if any real orders exist.

-- Restore the Milestone 4 versions of the four functions exactly as they were.
-- @@RESTORED_FUNCTIONS@@

DROP FUNCTION IF EXISTS public.checkout_place_order(uuid, jsonb, text, text, text, uuid, text, numeric, text, text);
DROP FUNCTION IF EXISTS public.checkout_quote(jsonb, text);
DROP FUNCTION IF EXISTS public._checkout_apply_delivery(uuid, text, jsonb, text);

ALTER TABLE public.orders
  DROP COLUMN IF EXISTS delivery_method,
  DROP COLUMN IF EXISTS delivery_fee_rand,
  DROP COLUMN IF EXISTS delivery_address,
  DROP COLUMN IF EXISTS payment_method;
COMMENT ON COLUMN public.orders.total_rand IS
  'Amount payable (item subtotal minus loyalty_discount_rand). Payment confirmation compares against this.';
DROP TABLE IF EXISTS public.delivery_options;
