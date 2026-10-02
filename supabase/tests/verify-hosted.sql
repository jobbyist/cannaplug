-- Run on the HOSTED database after applying migrations. Every row must come back with ok = true.
SELECT 'tables exist' AS check, count(*) = 13 AS ok FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('payment_transactions','webhook_events','webhook_rejections','fx_rates','payment_settings','notification_events','contact_submissions','newsletter_subscribers','ai_usage_counters','audit_log','orders','products','customer_verification')
UNION ALL
SELECT 'RLS on every public table', count(*) = 0 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
UNION ALL
SELECT 'only RLS helpers executable by browsers', COALESCE(array_agg(p.proname::text ORDER BY p.proname) = ARRAY['_current_doctor_id','current_user_role','has_at_least_role','has_role','is_staff'], false)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute'))
UNION ALL
SELECT 'anon holds no TRUNCATE/TRIGGER/REFERENCES', count(*) = 0 FROM information_schema.role_table_grants
  WHERE table_schema = 'public' AND grantee IN ('anon','authenticated') AND privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES')
UNION ALL
SELECT 'audit_log append-only triggers present', count(*) = 2 FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal
UNION ALL
SELECT 'payment settings seeded', count(*) = 6 FROM public.payment_settings
UNION ALL
SELECT 'unpaid-order confirmation bypass closed', position('payment_confirmation_required' IN pg_get_functiondef('public.transition_order_status(uuid,text,uuid,text)'::regprocedure)) > 0;
