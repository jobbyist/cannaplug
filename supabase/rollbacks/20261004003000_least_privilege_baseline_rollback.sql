-- Rollback for 20261004003000_least_privilege_baseline.sql: restores the previous (over-broad) default grants.
BEGIN;
GRANT ALL ON public.chat_rate_limits, public.newsroom_job_state, public.admin_api_subscriptions TO anon, authenticated;
GRANT ALL ON public.audit_log TO anon;
GRANT INSERT, UPDATE, DELETE ON public.audit_log TO authenticated;
GRANT ALL ON public.profiles, public.user_roles TO anon;
GRANT INSERT, UPDATE, DELETE ON public.products TO anon;
-- TRUNCATE/TRIGGER/REFERENCES are deliberately NOT restored: no role ever relied on them.
COMMIT;
