-- Rollback for 20261108001000_product_delete: removes product delete / restore and the archive columns, and puts the
-- price-history guard back exactly as it was (every DELETE refused). Roll the app back first (Products calls these
-- functions). Products already deleted stay deleted (their audit rows remain). Archived products stay switched off
-- and simply show again in the Products list as Inactive.
DROP FUNCTION IF EXISTS public.product_restore(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.product_delete(uuid, uuid, text);
DROP FUNCTION IF EXISTS public._product_has_history(uuid);
DROP TRIGGER IF EXISTS products_archive_consistency ON public.products;
DROP FUNCTION IF EXISTS public._products_archive_consistency();
ALTER TABLE public.products DROP COLUMN IF EXISTS archived_by;
ALTER TABLE public.products DROP COLUMN IF EXISTS archived_at;

CREATE OR REPLACE FUNCTION public.validate_product_price_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product price history cannot be deleted';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.product_id IS DISTINCT FROM NEW.product_id
     OR OLD.price_rand IS DISTINCT FROM NEW.price_rand
     OR OLD.effective_from IS DISTINCT FROM NEW.effective_from
     OR OLD.changed_by IS DISTINCT FROM NEW.changed_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.effective_to IS NOT NULL
     OR NEW.effective_to IS NULL
     OR NEW.effective_to > statement_timestamp() THEN
    RAISE EXCEPTION 'product price history is append-only; only closing the active interval is allowed';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.validate_product_price_history_mutation() FROM PUBLIC, anon, authenticated;
