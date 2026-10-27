import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  cash,
  connect,
  key,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

/**
 * The sale price set in /admin → Products is what both the till and online checkout charge, and an ended sale
 * goes back to the regular price everywhere.
 */
describe.skipIf(!DB_URL)("sale prices at the till and online (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let sessionId: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
    ({ sessionId } = await mkSession(sql, manager, cashier));
  });
  afterAll(async () => {
    await sql.end();
  });

  /** Regular R100, on sale for R80 (as the admin product editor stores it). */
  const onSale = async (endsAt: Date | null) => {
    const id = await mkProduct(sql, 100);
    await sql`UPDATE public.products SET price_rand = 80, regular_price_rand = 100, sale_ends_at = ${endsAt}
              WHERE id = ${id}`;
    await receive(sql, manager, id, 20);
    return id;
  };
  /** Tendering exactly the expected amount: the till refuses a tender that does not match its own total. */
  const tillPrice = async (product: string, expected: number) => {
    const s = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: product, quantity: 1 }],
      [cash(expected)],
    );
    return Number(
      await val(
        sql`SELECT unit_price_rand FROM public.pos_sale_items WHERE sale_id = ${s.sale_id}`,
      ),
    );
  };
  const onlineTotal = async (product: string) =>
    Number(
      (await rpc(sql, "checkout_quote", [{ product_id: product, quantity: 1 }], "collection"))
        .total,
    );
  const order = (member: string, product: string, total: number) =>
    rpc(
      sql,
      "checkout_place_order",
      member,
      [{ product_id: product, quantity: 1 }],
      "Sale Test",
      "+27 82 000 0000",
      "collection",
      null,
      "eft",
      total,
      null,
      key("co"),
    );

  it("charges the sale price at the till and online while the sale runs", async () => {
    const product = await onSale(new Date(Date.now() + 86_400_000));
    expect(await tillPrice(product, 80)).toBe(80);
    expect(await onlineTotal(product)).toBe(80);
    const o = await order(await mkMember(sql), product, 80);
    expect(
      Number(await val(sql`SELECT total_rand FROM public.orders WHERE id = ${o.order_id}`)),
    ).toBe(80);
  });

  it("a sale with no end date keeps running", async () => {
    const product = await onSale(null);
    expect(await rpc(sql, "products_end_expired_sales", null)).toBeGreaterThanOrEqual(0);
    expect(await tillPrice(product, 80)).toBe(80);
  });

  it("an ended sale goes back to the regular price at the till and online, with an audit row", async () => {
    const product = await onSale(new Date(Date.now() - 60_000));
    expect(await rpc(sql, "products_end_expired_sales", null)).toBeGreaterThanOrEqual(1);
    const row = (
      await sql`SELECT price_rand, regular_price_rand, sale_ends_at FROM public.products WHERE id = ${product}`
    )[0]!;
    expect(Number(row["price_rand"])).toBe(100);
    expect(row["regular_price_rand"]).toBeNull();
    expect(row["sale_ends_at"]).toBeNull();
    expect(await tillPrice(product, 100)).toBe(100);
    expect(await onlineTotal(product)).toBe(100);
    // An order priced at the old sale price is refused rather than undercharged.
    const stale = await attempt(order(await mkMember(sql), product, 80));
    expect(stale.ok).toBe(false);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE action = 'product_sale_ended' AND entity_id = ${product}`,
        ),
      ),
    ).toBe(1);
    // Running again changes nothing.
    await rpc(sql, "products_end_expired_sales", null);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE action = 'product_sale_ended' AND entity_id = ${product}`,
        ),
      ),
    ).toBe(1);
  });

  it("only staff (or the scheduler) can run the sweep", async () => {
    const customer = await mkUser(sql, "customer");
    expect((await attempt(rpc(sql, "products_end_expired_sales", customer))).ok).toBe(false);
    expect((await attempt(rpc(sql, "products_end_expired_sales", cashier))).ok).toBe(true);
  });
});
