-- Milestone 6 audit finding: the earliest tables still carried Supabase's default "ALL on everything" grants for
-- anon/authenticated. RLS already blocked row access, but TRUNCATE / TRIGGER / REFERENCES are not subject to RLS and
-- the browser roles never need them; service-only tables should not be visible to browsers at all.
-- Behaviour change: none for the app (every browser read/write goes through an RLS policy that is kept as is).

-- Never needed by a browser role, on any table.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Service-only tables: no browser access of any kind.
REVOKE ALL ON public.chat_rate_limits, public.newsroom_job_state, public.admin_api_subscriptions FROM anon, authenticated;

-- The audit trail is append-only and written by the service role; staff may read it (RLS policy kept).
REVOKE ALL ON public.audit_log FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.audit_log FROM authenticated;

-- People and roles: anonymous visitors have no policy and no business here.
REVOKE ALL ON public.profiles, public.user_roles FROM anon;

-- The public catalogue is read-only for anonymous visitors (staff writes keep their RLS policies as authenticated).
REVOKE INSERT, UPDATE, DELETE ON public.products FROM anon;
