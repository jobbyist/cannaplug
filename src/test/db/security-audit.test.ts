import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, connect, type Sql } from "./helpers";

/**
 * Milestone 6 database audit. Every SECURITY DEFINER function is a privilege boundary; only the five RLS helper
 * functions may be callable by browsers. Everything else is service-role only. Every table has RLS.
 */
describe.skipIf(!DB_URL)("database privilege audit (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(5)));
  afterAll(async () => void (await sql.end()));

  const BROWSER_CALLABLE = [
    "_current_doctor_id",
    "current_user_role",
    "has_at_least_role",
    "has_role",
    "is_staff",
  ];

  it("only the RLS helper functions are executable by anon or authenticated", async () => {
    const rows = await sql`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute'))
      ORDER BY 1`;
    expect(rows.map((r) => r["proname"])).toEqual(BROWSER_CALLABLE);
  });

  it("every public table has row level security enabled", async () => {
    const rows = await sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`;
    expect(rows.map((r) => r["relname"])).toEqual([]);
  });

  it("SECURITY DEFINER functions pin search_path (no schema-hijack)", async () => {
    const rows = await sql`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%')
      ORDER BY 1`;
    expect(rows.map((r) => r["proname"])).toEqual([]);
  });

  it("anonymous visitors can read only public catalogue tables and write nothing", async () => {
    const rows = await sql`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = 'anon' ORDER BY 1, 2`;
    const grants = rows.map((r) => `${r["table_name"]}:${r["privilege_type"]}`);
    expect(grants).toEqual(["articles:SELECT", "delivery_options:SELECT", "products:SELECT"]);
  });

  it("no browser role holds TRUNCATE, TRIGGER or REFERENCES anywhere (they bypass RLS)", async () => {
    const rows = await sql`
      SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated') AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')`;
    expect(rows).toEqual([]);
  });

  it("service-only tables are invisible to browsers, and audit_log is append-only for them", async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated')
        AND table_name IN ('chat_rate_limits', 'newsroom_job_state', 'admin_api_subscriptions', 'ai_usage_counters', 'payment_transactions_secret')`;
    expect(rows).toEqual([]);
    const audit = await sql`
      SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'audit_log' AND grantee IN ('anon', 'authenticated') AND privilege_type <> 'SELECT'`;
    expect(audit).toEqual([]);
  });
});
