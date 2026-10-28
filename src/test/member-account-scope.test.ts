import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => chain("inventory_availability", []) },
}));
vi.mock("@/lib/product-image-url.server", () => ({ productImageUrl: () => null }));

type Call = { table: string; filters: [string, unknown][] };
const calls: Call[] = [];
function chain(table: string, filters: [string, unknown][]) {
  const call: Call = { table, filters };
  calls.push(call);
  const result = {
    data: table === "loyalty_accounts" || table === "customer_verification" ? null : [],
    error: null,
  };
  const q: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
      Promise.resolve(result).then(ok, bad),
  };
  for (const m of ["select", "order", "limit", "in", "maybeSingle"]) q[m] = () => q;
  q["is"] = (col: string, v: unknown) => {
    filters.push([col, v]);
    return q;
  };
  q["eq"] = (col: string, v: unknown) => {
    filters.push([col, v]);
    return q;
  };
  return q;
}

import { getMemberAccount, type UserClient } from "@/lib/member-data.server";

describe("a signed-in person's own account", () => {
  it("filters every personal table by their user id, so staff RLS cannot mix in other members' rows", async () => {
    const db = { from: (t: string) => chain(t, []) } as unknown as UserClient;
    await getMemberAccount(db, "me-123");
    const personal = [
      "orders",
      "addresses",
      "loyalty_accounts",
      "loyalty_transactions",
      "wishlist_items",
      "back_in_stock_subscriptions",
      "customer_verification",
    ];
    for (const t of personal) {
      const c = calls.find((x) => x.table === t);
      expect(c, t).toBeTruthy();
      expect(c!.filters, t).toContainEqual(["user_id", "me-123"]);
    }
    // Orders the team archived (test or abandoned) never show in the member's account.
    expect(calls.find((x) => x.table === "orders")!.filters).toContainEqual(["archived_at", null]);
  });
});

describe("a signed-in person's own ID status", () => {
  it("is filtered by their user id (managers can read every member's row)", async () => {
    const { getMyVerification } = await import("@/lib/verification-data.server");
    calls.length = 0;
    const db = { from: (t: string) => chain(t, []) } as unknown as UserClient;
    await getMyVerification(db, "me-456");
    expect(calls.find((c) => c.table === "customer_verification")!.filters).toContainEqual([
      "user_id",
      "me-456",
    ]);
  });
});
