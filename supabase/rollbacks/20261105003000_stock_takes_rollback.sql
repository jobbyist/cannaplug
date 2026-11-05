-- Rollback for 20261105003000_stock_takes: removes stock takes, quick adjust and delivery receiving. Roll the app back
-- first (the Inventory tab calls these functions). Stock movements already made stay: they are ordinary
-- inventory_ledger rows (adjustment / receipt) and the batches they created remain, so on-hand numbers do not change.
-- Export stock_takes and stock_take_lines first if the count history matters.
DROP FUNCTION IF EXISTS public.stock_take_cancel(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.stock_take_post(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.stock_take_record_count(uuid, uuid, uuid, integer, text);
DROP FUNCTION IF EXISTS public.stock_take_start(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.stock_receive_delivery(uuid, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.stock_quick_adjust(uuid, uuid, integer, text, text);
DROP FUNCTION IF EXISTS public._stock_move_product(uuid, uuid, integer, text, text, uuid, text);
DROP FUNCTION IF EXISTS public._product_on_hand(uuid);
DROP TABLE IF EXISTS public.stock_take_lines;
DROP TABLE IF EXISTS public.stock_takes;
