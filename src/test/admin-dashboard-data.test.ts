import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  role: "manager" as string,
  orderFilters: [] as [string, unknown][],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    const rows = table === "user_roles" ? [{ role: h.role }] : [];
    const q: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(ok, bad),
    };
    for (const m of ["select", "order", "limit", "in", "lt", "gt", "eq"]) q[m] = () => q;
    q["is"] = (col: string, v: unknown) => {
      if (table === "orders") h.orderFilters.push([col, v]);
      return q;
    };
    return q;
  };
  return { supabaseAdmin: { from: chain, rpc: h.rpc } };
});
vi.mock("@/lib/product-image-url.server", () => ({ productImageUrl: () => null }));

import {
  getAdminDashboard,
  getAttentionCounts,
  listAdminOrders,
  listCustomersPage,
  setOrderArchived,
} from "@/lib/admin-data.server";

const overview = {
  today: { pos: "120.50", online: 80 },
  week: { pos: 1000, online: "500.25" },
  month: { pos: 4000, online: 2000 },
  all_time: { pos: 100000.1, online: 50000.2 },
  daily: [
    { day: "2026-10-26", pos: 10, online: 5 },
    { day: "2026-10-27", pos: 0, online: 0 },
  ],
  top_products: [{ name: "Blue Gelato", qty: 12, revenue: "840.00" }],
  counts: { paid_online: 40, till_sales: 160, customers: 55, online_orders: 70 },
};

beforeEach(() => {
  h.rpc.mockReset();
  h.role = "manager";
  h.orderFilters.length = 0;
  h.rpc.mockImplementation(async (name: string) => {
    if (name === "admin_overview") return { data: overview, error: null };
    if (name === "admin_attention_counts")
      return {
        data: { low_stock: 3, orders_to_pack: 1, id_checks: 0, variances: 2, eft_waiting: 2 },
        error: null,
      };
    return { data: null, error: null };
  });
});

describe("the overview numbers come from the database, not from app-side sums", () => {
  it("maps revenue (till + online), SAST chart days, best sellers and counts", async () => {
    const d = await getAdminDashboard("staff-1");
    expect(h.rpc).toHaveBeenCalledWith("admin_overview", { p_actor: "staff-1" });
    expect(d.stats.revenue.today).toEqual({ pos: 120.5, online: 80, total: 200.5 });
    expect(d.stats.revenue.week.total).toBe(1500.25);
    expect(d.stats.revenue.month.total).toBe(6000);
    expect(d.stats.revenue.allTime.total).toBe(150000.3);
    expect(d.stats).toMatchObject({
      paidOnline: 40,
      tillSales: 160,
      totalSales: 200,
      totalCustomers: 55,
      inventoryAlerts: 3,
    });
    expect(d.salesOverview.map((x) => x.label)).toEqual(["Mon", "Tue"]);
    expect(d.salesOverview[0]).toMatchObject({ day: "2026-10-26", pos: 10, online: 5, total: 15 });
    expect(d.topProducts).toEqual([{ name: "Blue Gelato", sold: 12, revenue: 840 }]);
  });

  it("survives an empty database", async () => {
    h.rpc.mockImplementation(async () => ({ data: {}, error: null }));
    const d = await getAdminDashboard("staff-1");
    expect(d.stats.revenue.allTime).toEqual({ pos: 0, online: 0, total: 0 });
    expect(d.salesOverview).toEqual([]);
    expect(d.topProducts).toEqual([]);
  });

  it("raises a database error instead of showing wrong numbers", async () => {
    h.rpc.mockImplementation(async (name: string) =>
      name === "admin_overview"
        ? { data: null, error: new Error("boom") }
        : { data: {}, error: null },
    );
    await expect(getAdminDashboard("staff-1")).rejects.toThrow("boom");
  });

  it("is for staff only", async () => {
    h.role = "customer";
    await expect(getAdminDashboard("member-1")).rejects.toThrow(/Forbidden/);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("attention counts, customers and archiving go through the database functions", () => {
  it("returns every count as a number", async () => {
    expect(await getAttentionCounts("s")).toEqual({
      orders_to_pack: 1,
      id_checks: 0,
      variances: 2,
      low_stock: 3,
      eft_waiting: 2,
    });
  });

  it("pages customers with the search sent to the database, never loading the whole list", async () => {
    h.rpc.mockImplementation(async () => ({
      data: {
        total: "61",
        rows: [
          {
            id: "c1",
            full_name: "A",
            phone: null,
            email: "a@x.co",
            member_since: "2026-10-01T00:00:00Z",
            order_count: "2",
            spend_rand: "99.50",
          },
        ],
      },
      error: null,
    }));
    const page = await listCustomersPage("s", { search: "  thandi ", limit: 25, offset: 50 });
    expect(h.rpc).toHaveBeenCalledWith("admin_customers_page", {
      p_actor: "s",
      p_search: "thandi",
      p_limit: 25,
      p_offset: 50,
    });
    expect(page.total).toBe(61);
    expect(page.rows[0]).toMatchObject({ order_count: 2, spend_rand: 99.5 });
    await listCustomersPage("s", { search: "   " });
    expect(h.rpc).toHaveBeenLastCalledWith("admin_customers_page", {
      p_actor: "s",
      p_search: null,
      p_limit: 25,
      p_offset: 0,
    });
  });

  it("archiving needs a manager, and the browser's reason and key reach the database function", async () => {
    h.role = "budtender";
    await expect(setOrderArchived("b", "o1", true, "test order", "key-12345678")).rejects.toThrow(
      /Forbidden/,
    );
    h.role = "manager";
    h.rpc.mockResolvedValue({ data: { changed: true, archived: true }, error: null });
    expect(await setOrderArchived("m", "o1", true, "test order", "key-12345678")).toEqual({
      changed: true,
      archived: true,
    });
    expect(h.rpc).toHaveBeenCalledWith("admin_set_order_archived", {
      p_actor: "m",
      p_order_id: "o1",
      p_archived: true,
      p_reason: "test order",
      p_idempotency_key: "key-12345678",
    });
  });

  it("the order list hides archived orders unless asked for them", async () => {
    await listAdminOrders("s", {});
    expect(h.orderFilters).toContainEqual(["archived_at", null]);
    h.orderFilters.length = 0;
    await listAdminOrders("s", { includeArchived: true });
    expect(h.orderFilters).toEqual([]);
  });
});
