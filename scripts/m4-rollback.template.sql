-- Rollback for Milestone 4 (20260930001000_member_account_live.sql).
-- DESTROYS loyalty accounts/transactions, wishlists and back-in-stock subscriptions created since the
-- migration. The pre-existing POS loyalty_ledger is untouched and remains the source of POS points.
-- Run only on a database where the migration was applied; objects are dropped IF EXISTS so a partial
-- apply can also be unwound.

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['orders', 'order_status_history', 'loyalty_accounts', 'loyalty_transactions'] LOOP
      IF EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
        -- orders / order_status_history were not in the publication before M4 on a fresh project;
        -- on hosted projects that already published them, re-add them manually if needed.
        EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END
$$;

DROP TRIGGER IF EXISTS orders_loyalty_on_status ON public.orders;
DROP TRIGGER IF EXISTS loyalty_ledger_mirror ON public.loyalty_ledger;

-- Restore the Milestone 3 POS functions exactly as they were.
-- @@ACCRUE_POS_LOYALTY@@
-- @@POS_REFUND_SALE@@

DROP FUNCTION IF EXISTS public.create_reorder(uuid, uuid, numeric, text);
DROP FUNCTION IF EXISTS public.reorder_check(uuid, uuid);
DROP FUNCTION IF EXISTS public.claim_back_in_stock_notifications(integer);
DROP FUNCTION IF EXISTS public.redeem_loyalty_points(uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public._orders_loyalty_trigger();
DROP FUNCTION IF EXISTS public.reverse_order_loyalty(uuid);
DROP FUNCTION IF EXISTS public.accrue_order_loyalty(uuid);
DROP FUNCTION IF EXISTS public._loyalty_ledger_mirror();

DROP TABLE IF EXISTS public.back_in_stock_subscriptions;
DROP TABLE IF EXISTS public.wishlist_items;
DROP TABLE IF EXISTS public.loyalty_transactions;
DROP TABLE IF EXISTS public.loyalty_accounts;
DROP TABLE IF EXISTS public.loyalty_rules;
DROP TABLE IF EXISTS public.loyalty_tiers;

-- Put the legacy (empty, unused) table back under its original name if the migration moved it aside.
DO $$
BEGIN
  IF to_regclass('public.loyalty_transactions_legacy') IS NOT NULL
     AND to_regclass('public.loyalty_transactions') IS NULL THEN
    ALTER TABLE public.loyalty_transactions_legacy RENAME TO loyalty_transactions;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loyalty_transactions_legacy_pkey') THEN
      ALTER TABLE public.loyalty_transactions RENAME CONSTRAINT loyalty_transactions_legacy_pkey TO loyalty_transactions_pkey;
    END IF;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public._back_in_stock_guard();
DROP FUNCTION IF EXISTS public._wishlist_guard();
DROP FUNCTION IF EXISTS public._product_available(uuid);
DROP FUNCTION IF EXISTS public._loyalty_apply_txn();
DROP FUNCTION IF EXISTS public._loyalty_account_guard();
DROP FUNCTION IF EXISTS public._loyalty_points_for_amount(numeric);
DROP FUNCTION IF EXISTS public._loyalty_rule(text);

ALTER TABLE public.orders
  DROP COLUMN IF EXISTS loyalty_points_redeemed,
  DROP COLUMN IF EXISTS loyalty_discount_rand;
COMMENT ON COLUMN public.orders.total_rand IS NULL;

-- Order timeline: back to staff-only table-level reads.
DROP POLICY IF EXISTS "own order status history" ON public.order_status_history;
REVOKE SELECT ON public.order_status_history FROM authenticated;
GRANT SELECT ON public.order_status_history TO authenticated;

-- Addresses: restore the Milestone 1 column-level client write grants.
GRANT INSERT (
  user_id, label, recipient_name, phone, line1, line2, suburb, city,
  province, postal_code, country, delivery_notes, is_default
) ON public.addresses TO authenticated;
GRANT UPDATE (
  label, recipient_name, phone, line1, line2, suburb, city, province,
  postal_code, country, delivery_notes, is_default, updated_at
) ON public.addresses TO authenticated;
GRANT DELETE ON public.addresses TO authenticated;

DROP FUNCTION IF EXISTS public.member_delete_address(uuid, uuid);
DROP FUNCTION IF EXISTS public.member_set_default_address(uuid, uuid);
DROP FUNCTION IF EXISTS public.member_save_address(uuid, uuid, jsonb, boolean);
