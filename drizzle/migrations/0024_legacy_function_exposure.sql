-- Milestone 6 hosted-database audit finding: four legacy SECURITY DEFINER functions (created outside this repository's
-- migrations) were executable by `anon` and `authenticated`:
--   cleanup_old_rate_limits()  — an ordinary function: any visitor could delete chat rate-limit rows (reset limits).
--   handle_admin_signup(), update_user_tier(), rls_auto_enable() — trigger / event-trigger functions: not callable as RPC,
--     but there is no reason for browser roles to hold EXECUTE on them.
-- Revoke browser access; the service role keeps EXECUTE. A no-op on databases that do not have these functions.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND p.proname IN ('cleanup_old_rate_limits', 'handle_admin_signup', 'update_user_tier', 'rls_auto_enable')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END
$$;
