import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, connect, type Sql } from "./helpers";

const root = new URL("../../../", import.meta.url).pathname;
const cleanup = readFileSync(root + "supabase/owner-actions/2026-10-hosted-cleanup.sql", "utf8");
const verify = readFileSync(root + "supabase/tests/verify-cleanup.sql", "utf8");

describe.skipIf(!DB_URL)("hosted clean-up script (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = connect(1);
    // Supabase creates this schema on hosted projects; the local harness does not.
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[])`);
  });
  afterAll(async () => void (await sql.end()));

  it("runs cleanly twice and leaves every check true", async () => {
    await sql.unsafe(cleanup);
    await sql.unsafe(cleanup); // idempotent
    const [row] = await sql.unsafe(verify);
    expect(row).toEqual({
      old_policies_gone: true,
      old_overload_gone: true,
      current_overload_present: true,
      http_extension_gone: true,
      id_migrations_recorded: true,
    });
  });
});
