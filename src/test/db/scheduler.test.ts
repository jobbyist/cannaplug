import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, asUser, attempt, connect, mkUser, rpc, type Sql } from "./helpers";

describe.skipIf(!DB_URL)("database scheduler fallback (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(4)));
  afterAll(async () => void (await sql.end()));

  it("knows only the three app jobs and is a no-op until Vault holds the URL and secret", async () => {
    for (const job of ["dispatch", "maintenance", "newsroom-daily"])
      expect(await rpc(sql, "scheduler_call_app", job), job).toBeNull();
    const bad = await attempt(rpc(sql, "scheduler_call_app", "https://evil.example/x"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/^invalid_input/);
  });

  it("cannot be called from a browser", async () => {
    const admin = await mkUser(sql, "admin");
    const r = await attempt(
      asUser(sql, admin, (tx) => tx`SELECT public.scheduler_call_app('dispatch')`),
    );
    expect(r.ok).toBe(false);
  });
});
