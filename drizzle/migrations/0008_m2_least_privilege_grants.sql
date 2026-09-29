-- Least-privilege table grants for the Milestone 2 stock, price-history and order tables.
--
-- Hosted Supabase grants ALL privileges on new public tables to anon and authenticated by default.
-- RLS already blocks reads/writes through the API, but privilege hygiene should not depend on RLS
-- alone: TRUNCATE, TRIGGER and REFERENCES are not subject to RLS at all, and a future loosened
-- policy would otherwise expose writes. All writes to these tables are made server-side by
-- SECURITY DEFINER functions / service_role, which keep their privileges.
--
-- Read access for signed-in staff is unchanged (RLS staff-read policies + security_invoker views
-- such as inventory_availability need SELECT for the invoker).

-- Stock, price and order-history tables: server-side writes only.
REVOKE ALL ON public.inventory_batches, public.inventory_ledger, public.product_price_history,
  public.order_status_history FROM anon, authenticated;
GRANT SELECT ON public.inventory_batches, public.inventory_ledger, public.product_price_history,
  public.order_status_history TO authenticated;

-- Orders: no anonymous access at all; signed-in users keep read access (RLS scopes it to their own
-- orders / staff). Order lines are an immutable snapshot, so no client write privilege at all.
REVOKE ALL ON public.orders, public.order_items FROM anon;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.orders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.order_items FROM authenticated;
