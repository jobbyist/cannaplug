-- Rollback for 20260929011000_m2_least_privilege_grants.sql.
-- Restores the previous (Supabase default) broad grants exactly as they were on the hosted project.
-- Only use this if a legitimate client-side write path is discovered; prefer adding a narrow
-- policy + grant for that path instead.

GRANT ALL ON public.inventory_batches, public.inventory_ledger, public.product_price_history,
  public.order_status_history TO anon, authenticated;

GRANT ALL ON public.orders TO anon;
GRANT ALL ON public.order_items TO anon;
-- orders previously had no INSERT/UPDATE for authenticated (INSERT was revoked by the Milestone 3 migration).
GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.orders TO authenticated;
GRANT UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.order_items TO authenticated;
