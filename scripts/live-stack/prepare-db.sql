-- Prepares a blank database the way hosted Supabase looks BEFORE the app's migrations run.
-- Local, disposable, test-only. Passwords are intentionally trivial.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Roles are cluster-wide, so they survive a database re-creation: create each one only if missing.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('anon', 'NOLOGIN NOINHERIT'),
    ('authenticated', 'NOLOGIN NOINHERIT'),
    ('service_role', 'NOLOGIN NOINHERIT BYPASSRLS'),
    ('authenticator', 'LOGIN NOINHERIT PASSWORD ''live-pass'''),
    ('supabase_auth_admin', 'LOGIN NOINHERIT CREATEROLE PASSWORD ''live-pass'''),
    ('supabase_admin', 'LOGIN SUPERUSER PASSWORD ''live-pass'''),
    -- test-only: storage-api runs its own migrations and creates the storage schema
    ('supabase_storage_admin', 'LOGIN SUPERUSER PASSWORD ''live-pass''')
  ) AS t(name, opts)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I %s', r.name, r.opts);
    END IF;
  END LOOP;
  GRANT anon, authenticated, service_role TO authenticator;
END $$;

ALTER ROLE supabase_storage_admin SET search_path = storage, public;
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
ALTER ROLE supabase_auth_admin SET search_path = auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;

CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION supabase_admin;
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION supabase_admin;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Hosted Supabase grants ALL on every new public object to these roles by default; mirror it so
-- the migrations' REVOKEs are what produce least privilege (same as production).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
