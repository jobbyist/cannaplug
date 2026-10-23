import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  attempt,
  connect,
  key,
  mkMember,
  mkProduct,
  mkUser,
  placeOrder,
  rpc,
  stockOf,
  uid,
  val,
  type Sql,
} from "./helpers";

const hash = () => createHash("sha256").update(uid()).digest("hex");
const row = (over: Record<string, unknown> = {}) => {
  const sku = `T-${uid().slice(0, 8)}`;
  return {
    sku,
    name: `Imported ${sku}`,
    slug: `imported-${sku.toLowerCase()}`,
    category: "Flower",
    brand: "Brandco",
    price: "50.00",
    cost: "20.00",
    unit: null,
    sold_by_weight: false,
    opening_qty: 10,
    track_stock: true,
    sell_online: true,
    ...over,
  };
};

describe.skipIf(!DB_URL)("import_catalogue (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => void (await sql.end()));

  const run = (rows: unknown[], h = hash(), deactivate = false) =>
    rpc(sql, "import_catalogue", manager, rows, h, "yoco_pos", deactivate, key("imp"));

  it("creates products with opening stock through the ledger, once per file", async () => {
    const a = row();
    const b = row({ opening_qty: 0 });
    const h = hash();
    const first = await run([a, b], h);
    expect(first).toMatchObject({ created: 2, updated: 0, stocked_products: 1, opening_units: 10 });
    const id = await val(sql`SELECT id FROM public.products WHERE sku = ${a.sku}`);
    expect((await stockOf(sql, id)).on_hand).toBe(10);
    const again = await run([a, b], h);
    expect(again.already_imported).toBe(true);
    expect((await stockOf(sql, id)).on_hand).toBe(10);
    expect(
      await val(sql`SELECT count(*)::int FROM public.inventory_ledger WHERE product_id = ${id}`),
    ).toBe(1);
  });

  it("updates by SKU (case-insensitive) and never adds opening stock twice", async () => {
    const a = row();
    await run([a]);
    const r = await run([{ ...a, sku: a.sku.toLowerCase(), price: "55.00", opening_qty: 99 }]);
    expect(r).toMatchObject({ created: 0, updated: 1, stocked_products: 0 });
    const p =
      await sql`SELECT price_rand, cost_rand FROM public.products WHERE lower(sku) = lower(${a.sku})`;
    expect(Number(p[0]!["price_rand"])).toBe(55);
    const id = await val(sql`SELECT id FROM public.products WHERE lower(sku) = lower(${a.sku})`);
    expect((await stockOf(sql, id)).on_hand).toBe(10);
  });

  it("rolls back the whole file on a bad row and refuses duplicates in one file", async () => {
    const good = row();
    expect((await attempt(run([good, { ...row(), price: "abc" }]))).ok).toBe(false);
    expect(await val(sql`SELECT count(*)::int FROM public.products WHERE sku = ${good.sku}`)).toBe(
      0,
    );
    const d = row();
    expect((await attempt(run([d, { ...row(), sku: d.sku.toUpperCase() }]))).ok).toBe(false);
  });

  it("gives a renamed product a unique slug instead of failing", async () => {
    const existing = await mkProduct(sql);
    const slug = await val(sql`SELECT slug FROM public.products WHERE id = ${existing}`);
    const r = row({ slug });
    await run([r]);
    const got = await val(sql`SELECT slug FROM public.products WHERE sku = ${r.sku}`);
    expect(got).not.toBe(slug);
    expect(got.startsWith(slug)).toBe(true);
  });

  it("in-store-only products cannot be ordered online but can be sold at the till", async () => {
    const lounge = row({
      category: "Lounge",
      sell_online: false,
      track_stock: false,
      opening_qty: 0,
    });
    await run([lounge]);
    const id = await val(sql`SELECT id FROM public.products WHERE sku = ${lounge.sku}`);
    expect((await stockOf(sql, id)).on_hand).toBe(100000); // service capacity batch
    const member = await mkMember(sql);
    const o = await attempt(placeOrder(sql, member, [{ product_id: id, quantity: 1 }]));
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.message).toMatch(/not_sold_online/);
  });

  it("can switch off products missing from the file (checked inside a rolled-back transaction)", async () => {
    const keep = row();
    const other = await mkProduct(sql);
    await sql
      .begin(async (tx) => {
        const r =
          await tx`SELECT public.import_catalogue(${manager}::uuid, ${tx.json([keep])}::jsonb, ${hash()}, 'yoco_pos', true, ${key("imp")}) AS r`;
        expect(r[0]!["r"].deactivated).toBeGreaterThan(0);
        const active = await tx`SELECT is_active FROM public.products WHERE id = ${other}`;
        expect(active[0]!["is_active"]).toBe(false);
        throw new Error("rollback");
      })
      .catch((e) => expect((e as Error).message).toBe("rollback"));
    const after = await sql`SELECT is_active FROM public.products WHERE id = ${other}`;
    expect(after[0]!["is_active"]).toBe(true);
  });

  it("is manager-only and not callable by browsers", async () => {
    const bud = await mkUser(sql, "budtender");
    const r = await attempt(
      rpc(sql, "import_catalogue", bud, [row()], hash(), "yoco_pos", false, key("imp")),
    );
    expect(r.ok).toBe(false);
    const anon = await attempt(
      asAnon(
        sql,
        (tx) =>
          tx`SELECT public.import_catalogue(${uid()}::uuid, '[]'::jsonb, ${hash()}, 'yoco_pos', false, 'k-anon-1')`,
      ),
    );
    expect(anon.ok).toBe(false);
  });

  it("sale prices: regular price must be higher, and expired sales end", async () => {
    const p = await mkProduct(sql, 100);
    expect(
      (await attempt(sql`UPDATE public.products SET regular_price_rand = 90 WHERE id = ${p}`)).ok,
    ).toBe(false);
    await sql`UPDATE public.products SET price_rand = 80, regular_price_rand = 100, sale_ends_at = now() - interval '1 minute' WHERE id = ${p}`;
    expect(await rpc(sql, "end_expired_sales")).toBeGreaterThanOrEqual(1);
    const r = await sql`SELECT price_rand, regular_price_rand FROM public.products WHERE id = ${p}`;
    expect(Number(r[0]!["price_rand"])).toBe(100);
    expect(r[0]!["regular_price_rand"]).toBeNull();
    expect(
      (await attempt(sql`UPDATE public.products SET weight_step_g = 0.25 WHERE id = ${p}`)).ok,
    ).toBe(false);
  });
});
