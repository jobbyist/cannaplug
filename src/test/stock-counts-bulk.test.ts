import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  calls: [] as { product: string; key: string }[],
  inFlight: 0,
  maxInFlight: 0,
  failFor: new Set<string>(),
  fatalFor: new Set<string>(),
}));

vi.mock("@/lib/admin-data.server", () => ({ assertRole: vi.fn(async () => "budtender") }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async (_name: string, a: { p_product_id: string; p_idempotency_key: string }) => {
      db.inFlight++;
      db.maxInFlight = Math.max(db.maxInFlight, db.inFlight);
      await new Promise((r) => setTimeout(r, 2));
      db.inFlight--;
      db.calls.push({ product: a.p_product_id, key: a.p_idempotency_key });
      if (db.fatalFor.has(a.p_product_id))
        return { data: null, error: { message: "stock_take_closed: already posted" } };
      if (db.failFor.has(a.p_product_id))
        return { data: null, error: { message: "wrong_category: this count is only for Flower" } };
      return { data: { counted: 1 }, error: null };
    },
  },
}));

import { recordStockCounts } from "@/lib/stock-ops.server";

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ productId: `p${i}`, counted: i }));

describe("recordStockCounts (count-sheet upload)", () => {
  it("saves every line once, a few at a time, each with its own key", async () => {
    Object.assign(db, { calls: [], inFlight: 0, maxInFlight: 0 });
    db.failFor = new Set(["p3"]);
    db.fatalFor = new Set();
    const r = await recordStockCounts("u1", { stockTakeId: "t1", lines: lines(40), key: "up" });
    expect(r.saved).toBe(39);
    expect(r.failed).toEqual([{ productId: "p3", problem: expect.any(String) }]);
    expect(new Set(db.calls.map((c) => c.key)).size).toBe(40);
    expect(db.calls.every((c) => c.key === `up:${c.product}`)).toBe(true);
    expect(db.maxInFlight).toBeGreaterThan(1);
    expect(db.maxInFlight).toBeLessThanOrEqual(8);
  });

  it("stops and throws when the count was closed", async () => {
    Object.assign(db, { calls: [], inFlight: 0, maxInFlight: 0 });
    db.failFor = new Set();
    db.fatalFor = new Set(["p0"]);
    await expect(
      recordStockCounts("u1", { stockTakeId: "t1", lines: lines(40), key: "up" }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/stock_take_closed/) });
    expect(db.calls.length).toBeLessThan(40);
  });
});
