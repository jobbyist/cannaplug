-- Hosted clean-up, October 2026 (Prompt 1). Safe to run more than once.
-- Run in the Supabase SQL editor for project khltynzzcjhlujxbgyod, then run supabase/tests/verify-cleanup.sql.
-- Status on 23 Oct 2026: items 1-3 were already done on hosted; item 4 was applied by Claude on 23 Oct.
begin;

-- 1. Milestone 4.2 policies made inert by the least-privilege grants (managers could once flip status directly).
drop policy if exists "verification management insert" on public.customer_verification;
drop policy if exists "verification management update" on public.customer_verification;

-- 2. The 5-argument verification_submit overload replaced by the 6-argument form (with document expiry).
drop function if exists public.verification_submit(uuid, text, text, date, text);

-- 3. The http extension that was only needed to fetch migration files during the October apply.
drop extension if exists http;

-- 4. Record the two ID-verification migrations that were applied statement by statement.
insert into supabase_migrations.schema_migrations (version, name)
values ('20260930003000', '20260930003000_id_verification'),
       ('20260930004000', '20260930004000_id_verification_expiry')
on conflict (version) do nothing;

commit;
