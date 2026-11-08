-- 8 Nov 2026: delete products from /admin → Products (client request). Until now a product could only be deactivated,
-- so mistakes, duplicates and old placeholders stayed in the list for good.
--
-- product_delete(actor, product, key) decides what "delete" can safely mean for that product:
--   * Never sold, ordered, stocked, held or counted: the product is removed permanently, with its price history
--     (written automatically when it was created) and any wishlist / back-in-stock rows (ON DELETE CASCADE).
--   * Anything else: it is ARCHIVED instead. It is switched off (gone from the shop and the till as before) and
--     hidden from the Products and Inventory lists, but the row stays because orders, till sales, receipts, the stock
--     ledger and reports point at it. An archived product can be restored; switching it back on un-archives it.
--
-- Price history is append-only (validate_product_price_history_mutation refuses every DELETE). The only exception
-- added here is a transaction-local flag that product_delete sets for the one product it is removing, after it has
-- checked that the product has no history. Browsers have no DELETE grant on that table and cannot set the flag.
--
-- SECURITY DEFINER, search_path '', explicit actor, idempotency key, audit row, service role only (repo convention).

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES auth.users(id);
COMMENT ON COLUMN public.products.archived_at IS
  'Set by product_delete when a product with sales or stock history is deleted: hidden from admin lists, kept for records. Cleared when the product is switched back on.';

-- Switching a product back on (editor, CSV upload, restore) un-archives it; an archived product is never active.
CREATE OR REPLACE FUNCTION public._products_archive_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.is_active AND NEW.archived_at IS NOT NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.archived_at IS NOT NULL AND NOT OLD.is_active THEN
      NEW.archived_at := NULL;
      NEW.archived_by := NULL;
    ELSE
      NEW.is_active := false;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public._products_archive_consistency() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS products_archive_consistency ON public.products;
CREATE TRIGGER products_archive_consistency
BEFORE INSERT OR UPDATE OF is_active, archived_at ON public.products
FOR EACH ROW EXECUTE FUNCTION public._products_archive_consistency();

-- Same rules as before, plus the one product_delete exception.
CREATE OR REPLACE FUNCTION public.validate_product_price_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('cannaplug.deleting_product', true) = OLD.product_id::text THEN
      RETURN OLD;
    END IF;
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

-- True when anything that must be kept points at the product.
CREATE OR REPLACE FUNCTION public._product_has_history(p_product_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.order_items WHERE product_id = p_product_id)
      OR EXISTS (SELECT 1 FROM public.pos_sale_items WHERE product_id = p_product_id)
      OR EXISTS (SELECT 1 FROM public.inventory_ledger WHERE product_id = p_product_id)
      OR EXISTS (SELECT 1 FROM public.inventory_batches WHERE product_id = p_product_id)
      OR EXISTS (SELECT 1 FROM public.stock_reservations WHERE product_id = p_product_id)
      OR EXISTS (SELECT 1 FROM public.stock_take_lines WHERE product_id = p_product_id);
$$;
REVOKE EXECUTE ON FUNCTION public._product_has_history(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.product_delete(
  p_actor uuid,
  p_product_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_product record;
  v_result jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('product_delete', p_actor, p_idempotency_key,
    jsonb_build_object('p', p_product_id));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  SELECT id, name, sku, category, is_active, archived_at INTO v_product
  FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;

  IF public._product_has_history(p_product_id) THEN
    UPDATE public.products
    SET is_active = false,
        archived_at = COALESCE(archived_at, now()),
        archived_by = COALESCE(archived_by, p_actor)
    WHERE id = p_product_id;
    v_result := jsonb_build_object('mode', 'archived', 'product_id', p_product_id, 'name', v_product.name,
      'sku', v_product.sku);
    PERFORM public._audit(p_actor, 'product_archived', 'product', p_product_id,
      jsonb_build_object('name', v_product.name, 'sku', v_product.sku, 'category', v_product.category,
        'was_active', v_product.is_active));
  ELSE
    PERFORM set_config('cannaplug.deleting_product', p_product_id::text, true);
    DELETE FROM public.product_price_history WHERE product_id = p_product_id;
    DELETE FROM public.products WHERE id = p_product_id;
    PERFORM set_config('cannaplug.deleting_product', '', true);
    v_result := jsonb_build_object('mode', 'deleted', 'product_id', p_product_id, 'name', v_product.name,
      'sku', v_product.sku);
    -- entity_id keeps the old id so the audit trail can still be searched by it.
    PERFORM public._audit(p_actor, 'product_deleted', 'product', p_product_id,
      jsonb_build_object('name', v_product.name, 'sku', v_product.sku, 'category', v_product.category,
        'was_active', v_product.is_active));
  END IF;

  RETURN public._idem_finish('product_delete', p_actor, p_idempotency_key, v_result);
END;
$$;

-- Restore an archived product: it comes back switched on (the trigger clears archived_at).
CREATE OR REPLACE FUNCTION public.product_restore(
  p_actor uuid,
  p_product_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cached jsonb;
  v_product record;
  v_result jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'manager');
  v_cached := public._idem_begin('product_restore', p_actor, p_idempotency_key,
    jsonb_build_object('p', p_product_id));
  IF v_cached IS NOT NULL THEN RETURN v_cached || jsonb_build_object('replayed', true); END IF;

  SELECT id, name, archived_at INTO v_product FROM public.products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'product_not_found'; END IF;
  IF v_product.archived_at IS NULL THEN RAISE EXCEPTION 'product_not_archived'; END IF;

  UPDATE public.products SET is_active = true WHERE id = p_product_id;
  v_result := jsonb_build_object('product_id', p_product_id, 'name', v_product.name);
  PERFORM public._audit(p_actor, 'product_restored', 'product', p_product_id,
    jsonb_build_object('name', v_product.name));
  RETURN public._idem_finish('product_restore', p_actor, p_idempotency_key, v_result);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.product_delete(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.product_restore(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_delete(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.product_restore(uuid, uuid, text) TO service_role;
