import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  key,
  mkProduct,
  mkUser,
  rpc,
  stockOf,
  uid,
  val,
  type Sql,
} from "./helpers";
import { parseProductCsv, planProductCsv, type ExistingProduct } from "@/lib/product-csv";

const hash = () => createHash("sha256").update(uid()).digest("hex");
const sku = () => `CSV-${uid().slice(0, 8)}`;

describe.skipIf(!DB_URL)("bulk_upsert_products (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => void (await sql.end()));

  const run = (rows: unknown[], k = key("csv"), actor = manager) =>
    rpc(sql, "bulk_upsert_products", actor, rows, hash(), k);
  const product = async (s: string) =>
    (await sql`SELECT * FROM public.products WHERE sku = ${s}`)[0] as Record<string, any>;

  /** The server path: load the product as the planner sees it, plan a CSV, send the planned rows. */
  async function viaPlanner(csv: string) {
    const rows =
      await sql`SELECT p.*, EXISTS (SELECT 1 FROM public.inventory_batches b WHERE b.product_id = p.id)
                             AS has_stock_history FROM public.products p WHERE p.sku IS NOT NULL`;
    const plan = planProductCsv(parseProductCsv(csv), rows as unknown as ExistingProduct[]);
    expect(plan.issues).toEqual([]);
    return { plan, result: plan.rpcRows.length ? await run(plan.rpcRows) : null };
  }

  it("creates products with opening stock through the ledger and audits them", async () => {
    const s = sku();
    const r = await run([
      {
        sku: s,
        slug: s.toLowerCase(),
        name: "CSV Flower",
        category: "Flower",
        price: "150.00",
        cost: "70.00",
        sold_by_weight: true,
        opening_qty: 25,
      },
    ]);
    expect(r).toMatchObject({ created: 1, updated: 0, stocked_products: 1, opening_units: 25 });
    const p = await product(s);
    expect(Number(p["price_rand"])).toBe(150);
    expect(p["sold_by_weight"]).toBe(true);
    expect((await stockOf(sql, p["id"])).on_hand).toBe(25);
    expect(
      await val(sql`SELECT batch_code FROM public.inventory_batches WHERE product_id = ${p["id"]}`),
    ).toBe("OPENING-CSV");
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.audit_log WHERE entity_id = ${p["id"]} AND action = 'product_created'`,
      ),
    ).toBe(1);
  });

  it("changes only the fields in the file, clears with null, and logs field names", async () => {
    const s = sku();
    await run([
      {
        sku: s,
        name: "Keep me",
        category: "Edibles",
        price: "90.00",
        brand: "Brandco",
        cost: "40.00",
        description: "Original",
        opening_qty: 3,
      },
    ]);
    const r = await run([{ sku: s.toLowerCase(), price: "95.00", brand: null, opening_qty: 50 }]);
    expect(r).toMatchObject({ created: 0, updated: 1, stocked_products: 0 });
    const p = await product(s);
    expect(p).toMatchObject({
      name: "Keep me",
      brand: null,
      description: "Original",
      category: "Edibles",
    });
    expect(Number(p["price_rand"])).toBe(95);
    expect(Number(p["cost_rand"])).toBe(40);
    expect((await stockOf(sql, p["id"])).on_hand).toBe(3); // opening stock never added twice
    const meta = await val(sql`SELECT metadata FROM public.audit_log WHERE entity_id = ${p["id"]}
                               AND action = 'product_updated' ORDER BY created_at DESC LIMIT 1`);
    expect(meta.changed).toEqual(["brand", "price_rand"]);
    // field names and the price only: cost never reaches the audit log
    expect(Object.keys(meta).sort()).toEqual(["changed", "price_rand", "sku", "source"]);
    expect(meta.sku).toBe(s);
  });

  it("applies the planner's sale rules exactly (TypeScript and SQL agree)", async () => {
    const s = sku();
    await run([{ sku: s, name: "Sale test", category: "Drinks", price: "100.00" }]);
    const cases: [string, Record<string, unknown>][] = [
      [`sku,sale_price,sale_ends\n${s},80,2026-12-31`, { price_rand: 80, regular_price_rand: 100 }],
      [`sku,price\n${s},120`, { price_rand: 80, regular_price_rand: 120 }],
      [`sku,price\n${s},75`, { price_rand: 75, regular_price_rand: null, sale_ends_at: null }],
      [`sku,price,sale_price\n${s},90,60`, { price_rand: 60, regular_price_rand: 90 }],
      [`sku,sale_price\n${s},-`, { price_rand: 90, regular_price_rand: null }],
    ];
    for (const [csv, want] of cases) {
      const { plan } = await viaPlanner(csv);
      const p = await product(s);
      for (const [k, v] of Object.entries(want))
        expect(v === null ? p[k] : Number(p[k]), `${csv} → ${k}`).toBe(v);
      // what the planner previewed is what the database now holds
      const change = plan.updates[0]!.changes.find((c) => c.field === "price");
      if (change)
        expect(Number(change.to)).toBe(Number(p["regular_price_rand"] ?? p["price_rand"]));
    }
    expect(new Date((await product(s))["sale_ends_at"] ?? 0).getTime()).toBe(0);
  });

  it("refuses bad rows in the database too, and saves nothing from that upload", async () => {
    const good = sku();
    const other = sku();
    await run([
      { sku: other, name: "Has barcode", category: "CBD", price: "10.00", barcode: "BC-777" },
    ]);
    const bad: [string, unknown[]][] = [
      [
        "unknown field",
        [
          { sku: good, name: "x", category: "CBD", price: "1.00" },
          // a real column the upload must not touch (stock tracking is set by category)
          { sku: other, track_stock: false },
        ],
      ],
      [
        "barcode in use",
        [{ sku: good, name: "x", category: "CBD", price: "1.00", barcode: "bc-777" }],
      ],
      [
        "sale not lower",
        [{ sku: good, name: "x", category: "CBD", price: "10.00", sale_price: "10.00" }],
      ],
      ["incomplete new", [{ sku: good, name: "x", category: "CBD" }]],
      ["bad category", [{ sku: good, name: "x", category: "Weed", price: "1.00" }]],
      [
        "lounge online",
        [{ sku: good, name: "x", category: "Lounge", price: "1.00", sell_online: true }],
      ],
      ["move into lounge", [{ sku: other, category: "Lounge" }]],
      [
        "duplicate sku",
        [
          { sku: good, name: "x", category: "CBD", price: "1.00" },
          { sku: good.toLowerCase(), price: "2.00" },
        ],
      ],
      ["text where boolean", [{ sku: other, is_active: "no" }]],
    ];
    for (const [why, rows] of bad) {
      const r = await attempt(run(rows));
      expect(r.ok, why).toBe(false);
    }
    expect(await val(sql`SELECT count(*)::int FROM public.products WHERE sku = ${good}`)).toBe(0);
    expect(await product(other)).toMatchObject({ category: "CBD", track_stock: true });
  });

  it("creates Lounge services in store only with a service batch", async () => {
    const s = sku();
    await run([
      { sku: s, name: "Lounge booth", category: "Lounge", price: "50.00", opening_qty: 9 },
    ]);
    const p = await product(s);
    expect(p).toMatchObject({ sell_online: false, track_stock: false });
    expect((await stockOf(sql, p["id"])).on_hand).toBe(100000);
  });

  it("replays the same key without writing twice", async () => {
    const s = sku();
    const k = key("csv");
    const h = hash();
    const rows = [{ sku: s, name: "Once", category: "Vapes", price: "200.00", opening_qty: 4 }];
    await rpc(sql, "bulk_upsert_products", manager, rows, h, k);
    const again = await rpc(sql, "bulk_upsert_products", manager, rows, h, k);
    expect(again.replayed).toBe(true);
    expect((await stockOf(sql, (await product(s))["id"])).on_hand).toBe(4);
    expect(
      await val(sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'products_csv_imported'
                    AND metadata->>'created' = '1' AND created_at > now() - interval '1 minute'`),
    ).toBeGreaterThanOrEqual(1);
  });

  it("is manager-only and not callable by browsers", async () => {
    const id = await mkProduct(sql);
    const s = await val(
      sql`UPDATE public.products SET sku = ${sku()} WHERE id = ${id} RETURNING sku`,
    );
    for (const role of ["budtender", "customer"] as const) {
      const u = await mkUser(sql, role);
      const r = await attempt(run([{ sku: s, price: "1.00" }], key("csv"), u));
      expect(r.ok, role).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/forbidden/);
    }
    const viaBrowser = await attempt(
      asUser(
        sql,
        manager,
        (tx) =>
          tx`SELECT public.bulk_upsert_products(${manager}::uuid, ${tx.json([{ sku: s, price: "1.00" }])}::jsonb, ${hash()}, ${key("csv")})`,
      ),
    );
    expect(viaBrowser.ok).toBe(false);
    const anon = await attempt(
      asAnon(
        sql,
        (tx) =>
          tx`SELECT public.bulk_upsert_products(${manager}::uuid, '[]'::jsonb, ${hash()}, 'k-anon-123')`,
      ),
    );
    expect(anon.ok).toBe(false);
    expect(
      Number(
        (await sql`SELECT price_rand FROM public.products WHERE id = ${id}`)[0]!["price_rand"],
      ),
    ).toBe(50);
  });
});
