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
SELECT 'unpaid-order confirmation bypass closed', position('payment_confirmation_required' IN pg_get_functiondef('public.transition_order_status(uuid,text,uuid,text)'::regprocedure)) > 0
UNION ALL
SELECT 'MVP tables exist (25 Oct)', count(*) = 7 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('catalogue_imports','receipt_settings','pos_receipt_meta','pos_receipt_sends','order_prescription_links','purchase_limits','operation_idempotency')
UNION ALL
SELECT 'MVP functions exist and are service-role only', count(*) = 9 AND bool_and(NOT has_function_privilege('authenticated', p.oid, 'execute') AND has_function_privilege('service_role', p.oid, 'execute'))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('import_catalogue','bulk_upsert_products','payment_set_eft_details','link_prescription_to_order','order_prescription_summaries','clinical_readiness','purchase_limit_set','verification_reset_attempts','scheduler_call_app')
UNION ALL
SELECT 'product columns (brand, sale, featured, low-stock threshold)', count(*) = 5 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'products' AND column_name IN ('brand','regular_price_rand','sell_online','is_featured','low_stock_threshold')
UNION ALL
SELECT 'purchase-limit triggers present', count(*) = 2 FROM pg_trigger WHERE tgname IN ('order_items_purchase_limit','pos_sale_items_purchase_limit')
UNION ALL
SELECT 'clinical notification triggers present', count(*) = 2 FROM pg_trigger WHERE tgname IN ('document_requests_notify','medical_documents_notify')
UNION ALL
SELECT 'Yoco provider removed from payments', position('yoco' IN pg_get_constraintdef(c.oid)) = 0
  FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%provider%'
UNION ALL
SELECT 'database scheduler: three jobs active', (SELECT count(*) FROM cron.job WHERE jobname LIKE 'cannaplug-%' AND active) = 3
UNION ALL
SELECT 'database scheduler: Vault configured', (SELECT count(*) FROM vault.secrets WHERE name IN ('cannaplug_app_url','cannaplug_scheduler_secret')) = 2;

