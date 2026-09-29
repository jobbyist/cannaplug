-- Supabase linter 0011: pin the search_path of the pure order-transition helper.
-- The function references no relations, so an empty search_path is safe.
ALTER FUNCTION public.order_status_transition_allowed(text, text) SET search_path = '';
