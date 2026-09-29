-- Deterministic fingerprint of the Milestone 3 catalog objects. Run on the local test DB and on the
-- hosted project; the two result sets must be identical (guards against transcription drift).
WITH m3_tables AS (
  SELECT unnest(ARRAY['stock_reservations','operation_idempotency','payment_events','loyalty_ledger','cash_drawers',
    'pos_sessions','pos_sales','pos_sale_items','pos_tenders','pos_refunds','pos_refund_items','pos_refund_payouts',
    'inventory_batches','inventory_ledger','product_price_history']) AS t
),
m3_funcs AS (
  SELECT p.oid, p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[
    '_apply_ledger_to_batch','_reservation_guard','_reservation_apply','_append_only_guard','_pos_sale_update_guard',
    '_pos_sale_item_update_guard','_pos_session_update_guard','_check_pos_sale_consistency','_require_read_committed',
    '_assert_staff','_audit','_idem_begin','_idem_finish','_lock_batches','_expire_holds','_allocate_fefo',
    '_reserve_order_items','_consume_order_stock','_cancel_order_stock','pos_variance_tolerance','create_online_order',
    'reserve_order_stock','release_expired_reservations','purge_old_idempotency_keys','accrue_missing_pos_loyalty',
    'confirm_order_payment','transition_order_status','receive_stock','adjust_stock','pos_upsert_drawer',
    'pos_open_session','pos_close_session','pos_review_session','pos_complete_sale','pos_void_sale','pos_refund_sale',
    'accrue_pos_loyalty'])
)
SELECT kind, name, md5(detail) AS h FROM (
  SELECT 'function' AS kind, f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')' AS name,
         pg_get_functiondef(f.oid) AS detail FROM m3_funcs f
  UNION ALL
  SELECT 'function_acl', f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
         concat_ws(',', has_function_privilege('anon', f.oid, 'execute'),
                        has_function_privilege('authenticated', f.oid, 'execute'),
                        has_function_privilege('service_role', f.oid, 'execute')) FROM m3_funcs f
  UNION ALL
  SELECT 'column', c.table_name || '.' || c.column_name,
         concat_ws('|', c.data_type, c.is_nullable, coalesce(c.column_default, ''))
  FROM information_schema.columns c JOIN m3_tables t ON t.t = c.table_name WHERE c.table_schema = 'public'
  UNION ALL
  SELECT 'constraint', cl.relname || '.' || co.conname, pg_get_constraintdef(co.oid)
  FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid JOIN m3_tables t ON t.t = cl.relname
  WHERE cl.relnamespace = 'public'::regnamespace AND co.contype IN ('c', 'u', 'p', 'f')
  UNION ALL
  SELECT 'index', i.tablename || '.' || i.indexname, i.indexdef FROM pg_indexes i JOIN m3_tables t ON t.t = i.tablename
  WHERE i.schemaname = 'public'
  UNION ALL
  SELECT 'trigger', cl.relname || '.' || tg.tgname, pg_get_triggerdef(tg.oid)
  FROM pg_trigger tg JOIN pg_class cl ON cl.oid = tg.tgrelid JOIN m3_tables t ON t.t = cl.relname
  WHERE NOT tg.tgisinternal AND cl.relnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'policy', schemaname || '.' || tablename || '.' || policyname,
         concat_ws('|', cmd, roles::text, qual, with_check)
  FROM pg_policies WHERE schemaname = 'public' AND tablename IN (SELECT t FROM m3_tables)
  UNION ALL
  SELECT 'rls', cl.relname, cl.relrowsecurity::text FROM pg_class cl JOIN m3_tables t ON t.t = cl.relname
  WHERE cl.relnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'view', c.relname, pg_get_viewdef(c.oid)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('stock_movements','inventory_availability')
  UNION ALL
  SELECT 'table_acl', tb.table_name || '.' || tb.grantee, string_agg(tb.privilege_type, ',' ORDER BY tb.privilege_type)
  FROM information_schema.role_table_grants tb
  WHERE tb.table_schema = 'public' AND tb.grantee IN ('anon', 'authenticated')
    AND tb.table_name IN (SELECT t FROM m3_tables UNION SELECT 'orders' UNION SELECT 'order_items'
                          UNION SELECT 'stock_movements' UNION SELECT 'inventory_availability')
  GROUP BY tb.table_name, tb.grantee
) x
ORDER BY kind, name;
