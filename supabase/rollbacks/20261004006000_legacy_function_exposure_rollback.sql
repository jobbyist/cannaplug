-- Rollback for 20261004006000_legacy_function_exposure.sql. Intentionally a no-op: re-granting EXECUTE on these
-- functions to anon/authenticated would re-open the finding and nothing in the app relies on it.
SELECT 1;
