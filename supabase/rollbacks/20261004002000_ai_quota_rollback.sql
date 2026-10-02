-- Rollback for 20261004002000_ai_quota.sql (counters are disposable).
BEGIN;
DROP FUNCTION IF EXISTS public.ai_quota_take(text, integer, integer);
DROP FUNCTION IF EXISTS public.ai_quota_purge();
DROP TABLE IF EXISTS public.ai_usage_counters;
COMMIT;
