-- Rolls back 20261025001000_product_csv: removes the bulk upload function. Products it created or changed stay as they
-- are (they are ordinary products with ordinary audit rows); nothing else depends on the function.
DROP FUNCTION IF EXISTS public.bulk_upsert_products(uuid, jsonb, text, text);
