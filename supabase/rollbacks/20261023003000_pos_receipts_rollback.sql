-- Rollback for 20261023003000_pos_receipts. Removes receipt settings and the receipt send log (sales are untouched).
DROP TABLE IF EXISTS public.pos_receipt_sends;
DROP TABLE IF EXISTS public.pos_receipt_meta;
DROP TABLE IF EXISTS public.receipt_settings;
