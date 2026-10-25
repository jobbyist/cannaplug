-- 25 Oct 2026: one search box for the whole admin panel.
--   admin_search(actor, query) returns up to N matches each of orders, customers, products and till sales for any
--   staff member (budtender and up), in one round trip. Read-only: no idempotency key or audit row is needed, and it
--   returns nothing a budtender cannot already see on the Orders, Customers, Products and POS tabs (no cost prices,
--   no ID or health data). Trigram indexes keep "contains" searches fast as the tables grow.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS products_name_trgm ON public.products USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_sku_trgm ON public.products USING gin (sku extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_barcode_trgm ON public.products USING gin (barcode extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_number_trgm ON public.orders USING gin (order_number extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_contact_trgm ON public.orders USING gin (contact_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_name_trgm ON public.profiles USING gin (full_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS profiles_phone_trgm ON public.profiles USING gin (phone extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS pos_sales_receipt_trgm ON public.pos_sales USING gin (receipt_number extensions.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.admin_search(p_actor uuid, p_query text, p_limit integer DEFAULT 6)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_q text := btrim(COALESCE(p_query, ''));
  v_like text;
  v_digits text;
  v_n integer := LEAST(GREATEST(COALESCE(p_limit, 6), 1), 20);
  v_orders jsonb;
  v_customers jsonb;
  v_products jsonb;
  v_sales jsonb;
BEGIN
  PERFORM public._assert_staff(p_actor, 'budtender');
  IF length(v_q) < 2 OR length(v_q) > 100 THEN
    RETURN jsonb_build_object('orders', '[]'::jsonb, 'customers', '[]'::jsonb, 'products', '[]'::jsonb,
                              'sales', '[]'::jsonb);
  END IF;
  -- LIKE wildcards in the query are matched literally.
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- Phone numbers match with or without the 0 / +27 prefix and spacing: compare the national digits.
  v_digits := regexp_replace(regexp_replace(v_q, '[^0-9]', '', 'g'), '^(27|0)', '');

  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_orders FROM (
    SELECT o.id, o.order_number, o.contact_name, o.status, o.total_rand, o.delivery_method, o.created_at
    FROM public.orders o
    LEFT JOIN auth.users u ON u.id = o.user_id
    WHERE o.order_number ILIKE v_like OR o.contact_name ILIKE v_like OR u.email ILIKE v_like
       OR (length(v_digits) >= 4 AND regexp_replace(COALESCE(o.contact_phone, ''), '[^0-9]', '', 'g') LIKE '%' || v_digits || '%')
    ORDER BY (o.order_number ILIKE v_q) DESC, o.created_at DESC
    LIMIT v_n) r;

  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_customers FROM (
    SELECT p.id, p.full_name, p.phone, u.email, p.created_at,
           (SELECT count(*) FROM public.orders o WHERE o.user_id = p.id) AS order_count
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE (p.full_name ILIKE v_like OR u.email ILIKE v_like
           OR (length(v_digits) >= 4 AND regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g') LIKE '%' || v_digits || '%'))
      AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p.id
                      AND ur.role IN ('budtender', 'manager', 'admin'))
    ORDER BY (p.full_name ILIKE v_q) DESC, p.full_name
    LIMIT v_n) r;

  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_products FROM (
    SELECT p.id, p.name, p.category, p.sku, p.brand, p.price_rand, p.is_active,
           public._product_available(p.id) AS available
    FROM public.products p
    WHERE p.name ILIKE v_like OR p.sku ILIKE v_like OR p.barcode ILIKE v_like OR p.brand ILIKE v_like
    ORDER BY p.is_active DESC, (p.sku ILIKE v_q OR p.barcode ILIKE v_q) DESC, (p.name ILIKE v_q) DESC, p.name
    LIMIT v_n) r;

  SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_sales FROM (
    SELECT s.id, s.receipt_number, s.status, s.total, s.created_at
    FROM public.pos_sales s
    WHERE s.receipt_number ILIKE v_like
    ORDER BY s.created_at DESC
    LIMIT v_n) r;

  RETURN jsonb_build_object('orders', v_orders, 'customers', v_customers, 'products', v_products,
                            'sales', v_sales);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_search(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search(uuid, text, integer) TO service_role;
