import { afterAll, describe, expect, it } from "vitest";
import { connect, DB_URL } from "./helpers";

const WRITE = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const STOCK_TABLES = [
  "inventory_batches",
  "inventory_ledger",
  "product_price_history",
  "order_status_history",
];

describe.skipIf(!DB_URL)("Milestone 2 least-privilege grants", () => {
  const sql = DB_URL ? connect(2) : (undefined as never);
  afterAll(async () => {
    await sql?.end();
  });

  async function privs(table: string, role: string): Promise<string[]> {
    const rows = await sql`
      SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE has_table_privilege(${role}, ${"public." + table}, p) ORDER BY 1`;
    return rows.map((r) => r["p"] as string);
  }

  it.each(STOCK_TABLES)(
    "anon has no privileges and authenticated is read-only on %s",
    async (t) => {
      expect(await privs(t, "anon")).toEqual([]);
      expect(await privs(t, "authenticated")).toEqual(["SELECT"]);
    },
  );

  it("anon has nothing on orders / order_items", async () => {
    expect(await privs("orders", "anon")).toEqual([]);
    expect(await privs("order_items", "anon")).toEqual([]);
  });

  it("authenticated cannot INSERT/DELETE/TRUNCATE orders, and has no write on order_items", async () => {
    const o = await privs("orders", "authenticated");
    for (const p of ["INSERT", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
      expect(o).not.toContain(p);
    expect(o).toContain("SELECT");
    const i = await privs("order_items", "authenticated");
    for (const p of WRITE) expect(i).not.toContain(p);
    expect(i).toContain("SELECT");
  });

  it("service_role keeps full access (server-side writes are unaffected)", async () => {
    for (const t of [...STOCK_TABLES, "orders", "order_items"]) {
      const p = await privs(t, "service_role");
      for (const w of ["SELECT", "INSERT", "UPDATE"]) expect(p).toContain(w);
    }
  });

  it("authenticated can still read the availability view's underlying data", async () => {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT count(*) FROM public.inventory_availability`;
    });
  });
});
