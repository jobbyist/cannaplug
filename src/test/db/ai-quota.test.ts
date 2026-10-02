import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, asAnon, attempt, connect, rpc, uid, val, type Sql } from "./helpers";

describe.skipIf(!DB_URL)("ai_quota_take (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(20)));
  afterAll(async () => void (await sql.end()));

  it("counts up to the limit then refuses without counting further", async () => {
    const b = `test:${uid()}`;
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await rpc(sql, "ai_quota_take", b, 4, 60));
    expect(results).toEqual([true, true, true, true, false, false]);
    expect(await val(sql`SELECT count FROM public.ai_usage_counters WHERE bucket = ${b}`)).toBe(4);
  });
  it("is exact under concurrency: 30 simultaneous callers, limit 10 -> exactly 10 allowed", async () => {
    const b = `test:${uid()}`;
    const r = await Promise.all(
      Array.from({ length: 30 }, () => rpc(sql, "ai_quota_take", b, 10, 60)),
    );
    expect(r.filter(Boolean)).toHaveLength(10);
    expect(await val(sql`SELECT count FROM public.ai_usage_counters WHERE bucket = ${b}`)).toBe(10);
  });
  it("validates arguments, purges expired rows, and is service-role only", async () => {
    expect((await attempt(rpc(sql, "ai_quota_take", "x", 5, 60))).ok).toBe(false); // bucket name too short
    expect((await attempt(rpc(sql, "ai_quota_take", "valid:bucket", 0, 60))).ok).toBe(false);
    expect((await attempt(rpc(sql, "ai_quota_take", "valid:bucket", 5, 5))).ok).toBe(false);
    const b = `test:${uid()}`;
    await rpc(sql, "ai_quota_take", b, 5, 60);
    await sql`UPDATE public.ai_usage_counters SET expires_at = now() - interval '1 minute' WHERE bucket = ${b}`;
    expect(await rpc(sql, "ai_quota_purge")).toBeGreaterThanOrEqual(1);
    expect(
      await val(sql`SELECT count(*)::int FROM public.ai_usage_counters WHERE bucket = ${b}`),
    ).toBe(0);
    expect(
      (
        await attempt(
          asAnon(sql, async (tx) => tx`SELECT public.ai_quota_take('anon:bucket', 5, 60)`),
        )
      ).ok,
    ).toBe(false);
    expect(
      (await attempt(asAnon(sql, async (tx) => tx`SELECT * FROM public.ai_usage_counters`))).ok,
    ).toBe(false);
  });
});
