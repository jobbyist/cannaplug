-- Rollback for 20260929004000_live_admin_fulfilment.sql
-- Do not run while fulfilment/history/inventory data must be retained.
SET app.confirm_rollback = 'yes';

DO $$
BEGIN
  IF current_setting('app.confirm_rollback', true) <> 'yes' THEN
    RAISE EXCEPTION 'Set app.confirm_rollback = yes to run this rollback';
  END IF;
END $$;

DROP TRIGGER IF EXISTS products_price_history ON public.products;
DROP FUNCTION IF EXISTS public.record_product_price_history();
DROP FUNCTION IF EXISTS public.transition_order_status(uuid, text, uuid, text);
DROP FUNCTION IF EXISTS public.order_status_transition_allowed(text, text);

DROP TABLE IF EXISTS public.inventory_ledger;
DROP TABLE IF EXISTS public.inventory_batches;
DROP TABLE IF EXISTS public.product_price_history;
DROP TABLE IF EXISTS public.order_status_history;
