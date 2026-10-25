-- Rollback for 20261025005000_admin_search. The pg_trgm extension stays (harmless, may be used elsewhere).
DROP FUNCTION IF EXISTS public.admin_search(uuid, text, integer);
DROP INDEX IF EXISTS public.products_name_trgm, public.products_sku_trgm, public.products_barcode_trgm,
  public.orders_number_trgm, public.orders_contact_trgm, public.profiles_name_trgm, public.profiles_phone_trgm,
  public.pos_sales_receipt_trgm;
