import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  cash,
  connect,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

/** An Online Only sale: checkout charges the sale price, the till keeps charging the regular price. */
describe.skipIf(!DB_URL)("online-only sale prices (real PostgreSQL)", () => {
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

  const onSale = async (onlineOnly: boolean, endsAt: Date | null = null) => {
    const id = await mkProduct(sql, 100);
    await sql`UPDATE public.products
              SET price_rand = 80, regular_price_rand = 100, sale_ends_at = ${endsAt}, sale_online_only = ${onlineOnly}
              WHERE id = ${id}`;
    await receive(sql, manager, id, 20);
    return id;
  };
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

  it("online-only: checkout charges the sale price, the till charges the regular price", async () => {
    const product = await onSale(true);
    expect(await onlineTotal(product)).toBe(80);
    expect(await tillPrice(product, 100)).toBe(100);
  });

  it("a normal sale still applies at the till and online", async () => {
    const product = await onSale(false);
    expect(await onlineTotal(product)).toBe(80);
    expect(await tillPrice(product, 80)).toBe(80);
  });

  it("the flag clears itself when there is no sale, however the sale ended", async () => {
    const ended = await onSale(true, new Date(Date.now() - 60_000));
    await rpc(sql, "products_end_expired_sales", null);
    const row = (
      await sql`SELECT price_rand, sale_online_only FROM public.products WHERE id = ${ended}`
    )[0]!;
    expect(Number(row["price_rand"])).toBe(100);
    expect(row["sale_online_only"]).toBe(false);

    const manual = await onSale(true);
    await sql`UPDATE public.products SET price_rand = 100, regular_price_rand = NULL WHERE id = ${manual}`;
    expect(await val(sql`SELECT sale_online_only FROM public.products WHERE id = ${manual}`)).toBe(
      false,
    );
    expect(await tillPrice(manual, 100)).toBe(100);
  });
});
