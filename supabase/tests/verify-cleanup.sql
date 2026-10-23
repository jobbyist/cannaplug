-- Read-only check for supabase/owner-actions/2026-10-hosted-cleanup.sql: every column must be true.
select
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customer_verification'
              and policyname in ('verification management insert', 'verification management update')) as old_policies_gone,
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'verification_submit' and p.pronargs = 5) as old_overload_gone,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'verification_submit' and p.pronargs = 6) as current_overload_present,
  not exists (select 1 from pg_extension where extname = 'http') as http_extension_gone,
  (select count(*) = 2 from supabase_migrations.schema_migrations
    where version in ('20260930003000', '20260930004000')) as id_migrations_recorded;
