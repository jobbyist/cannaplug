import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  cash,
  connect,
  key,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

/** Till discounts are worked out in the database, in cents, and refunds give back what was really paid. */
describe.skipIf(!DB_URL)("POS discounts (real PostgreSQL)", () => {
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

  const product = async (price: number) => {
    const id = await mkProduct(sql, price);
    await receive(sql, manager, id, 50);
    return id;
  };
  const items = (sale: string) =>
    sql`SELECT product_id, unit_price_rand, quantity, line_discount_rand, order_discount_rand, line_total
        FROM public.pos_sale_items WHERE sale_id = ${sale} ORDER BY line_total`;

  it("a line discount (percent) lowers that line and the total, and is audited", async () => {
    const a = await product(100);
    const b = await product(50);
    const s = await sell(
      sql,
      cashier,
      sessionId,
      [
        { product_id: a, quantity: 2, discount: { kind: "percent", value: "10" } },
        { product_id: b, quantity: 1 },
      ],
      [cash(230)],
      { reason: "Loyal customer" },
    );
    expect(Number(s.total)).toBe(230);
    expect(Number(s.subtotal)).toBe(250);
    expect(Number(s.discount)).toBe(20);
    const rows = await items(s.sale_id);
    expect(rows.map((r) => Number(r["line_total"]))).toEqual([50, 180]);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE action = 'pos_sale_discount' AND entity_id = ${s.sale_id}`,
        ),
      ),
    ).toBe(1);
  });

  it("a line discount (amount) comes off the whole line", async () => {
    const a = await product(100);
    const s = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: a, quantity: 2, discount: { kind: "amount", value: "15.50" } }],
      [cash(184.5)],
      { reason: "Damaged tin" },
    );
    expect(Number(s.total)).toBe(184.5);
  });

  it("an order discount is shared across the lines to the cent", async () => {
    const [a, b, c] = [await product(10), await product(10), await product(10)] as [
      string,
      string,
      string,
    ];
    const s = await sell(
      sql,
      cashier,
      sessionId,
      [a, b, c].map((p) => ({ product_id: p, quantity: 1 })),
      [cash(29)],
      { orderDiscount: { kind: "amount", value: "1.00" }, reason: "Bundle" },
    );
    expect(Number(s.total)).toBe(29);
    const rows = await items(s.sale_id);
    const shares = rows.map((r) => Number(r["order_discount_rand"])).sort();
    expect(shares).toEqual([0.33, 0.33, 0.34]);
    expect(rows.reduce((t, r) => t + Number(r["line_total"]), 0)).toBeCloseTo(29, 2);
    expect(
      Number(await val(sql`SELECT discount_rand FROM public.pos_sales WHERE id = ${s.sale_id}`)),
    ).toBe(1);
  });

  it("an order discount applies after line discounts", async () => {
    const a = await product(100);
    const s = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: a, quantity: 1, discount: { kind: "percent", value: "10" } }],
      [cash(81)],
      { orderDiscount: { kind: "percent", value: "10" }, reason: "Staff friend" },
    );
    expect(Number(s.total)).toBe(81);
  });

  it("refuses a discount with no reason, a bad shape, or one that is too large", async () => {
    const a = await product(100);
    const line = (discount: unknown) => [{ product_id: a, quantity: 1, discount }];
    const tryIt = (discount: unknown, tender: number, reason: string | null = "Because") =>
      attempt(sell(sql, manager, sessionId, line(discount), [cash(tender)], { reason }));
    expect((await tryIt({ kind: "percent", value: "10" }, 90, null)).ok).toBe(false);
    expect((await tryIt({ kind: "percent", value: "10" }, 90, "x")).ok).toBe(false);
    expect((await tryIt({ kind: "bogus", value: "10" }, 90)).ok).toBe(false);
    expect((await tryIt({ kind: "percent", value: "101" }, 0.01)).ok).toBe(false);
    expect((await tryIt({ kind: "amount", value: "-5" }, 105)).ok).toBe(false);
    expect((await tryIt({ kind: "amount", value: "100.01" }, 0.01)).ok).toBe(false);
    // The whole sale must stay above zero.
    expect((await tryIt({ kind: "percent", value: "100" }, 0.01)).ok).toBe(false);
    // A correct one passes.
    expect((await tryIt({ kind: "percent", value: "10" }, 90)).ok).toBe(true);
  });

  it("the tender must match the discounted total (the browser's idea of the total is not trusted)", async () => {
    const a = await product(100);
    const r = await attempt(
      sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: a, quantity: 1, discount: { kind: "percent", value: "10" } }],
        [cash(100)],
        {
          reason: "Loyal customer",
        },
      ),
    );
    expect(r.ok).toBe(false);
  });

  it("cashiers can discount by any percentage without a manager, but a reason is still required and the sale must stay above R0", async () => {
    const a = await product(100);
    const off = (pct: string) => [
      { product_id: a, quantity: 1, discount: { kind: "percent", value: pct } },
    ];
    const ok = async (pct: string, pay: number, reason: string | null) =>
      (await attempt(sell(sql, cashier, sessionId, off(pct), [cash(pay)], { reason }))).ok;
    expect(await ok("20.01", 79.99, "Over the old limit")).toBe(true);
    expect(await ok("50", 50, "Half price clearance")).toBe(true);
    expect(await ok("99.5", 0.5, "Almost free")).toBe(true);
    // Still refused: no reason, and a free sale.
    expect(await ok("60", 40, null)).toBe(false);
    expect(await ok("100", 0, "Free")).toBe(false);
    // A cashier's order-level discount has no limit either, and is audited.
    const b = await product(200);
    const s = await sell(sql, cashier, sessionId, [{ product_id: b, quantity: 1 }], [cash(40)], {
      orderDiscount: { kind: "percent", value: "80" },
      reason: "Owner approved offer",
    });
    expect(Number(s.discount)).toBe(160);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE action = 'pos_sale_discount' AND entity_id = ${s.sale_id}`,
        ),
      ),
    ).toBe(1);
  });

  it("a sale with no discount is unchanged and writes no discount audit row", async () => {
    const a = await product(40);
    const s = await sell(sql, cashier, sessionId, [{ product_id: a, quantity: 2 }], [cash(80)]);
    expect(Number(s.discount)).toBe(0);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE action = 'pos_sale_discount' AND entity_id = ${s.sale_id}`,
        ),
      ),
    ).toBe(0);
  });

  it("a retry with the same key replays; the same key with a different discount is refused", async () => {
    const a = await product(100);
    const idem = key("disc");
    const args = [{ product_id: a, quantity: 1 }];
    const first = await sell(sql, cashier, sessionId, args, [cash(90)], {
      idem,
      orderDiscount: { kind: "percent", value: "10" },
      reason: "Retry",
    });
    const again = await sell(sql, cashier, sessionId, args, [cash(90)], {
      idem,
      orderDiscount: { kind: "percent", value: "10" },
      reason: "Retry",
    });
    expect(again.sale_id).toBe(first.sale_id);
    const other = await attempt(
      sell(sql, cashier, sessionId, args, [cash(80)], {
        idem,
        orderDiscount: { kind: "percent", value: "20" },
        reason: "Retry",
      }),
    );
    expect(other.ok).toBe(false);
  });

  it("refunds give back what was paid, pro-rata, and add up to the line exactly", async () => {
    const a = await product(100);
    const s = await sell(sql, manager, sessionId, [{ product_id: a, quantity: 3 }], [cash(290)], {
      orderDiscount: { kind: "amount", value: "10" },
      reason: "Regular",
    });
    const itemId = await val<string>(
      sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${s.sale_id}`,
    );
    const go = (qty: number, amount: number) =>
      rpc(
        sql,
        "pos_refund_sale",
        manager,
        s.sale_id,
        sessionId,
        [{ sale_item_id: itemId, quantity: qty }],
        [cash(amount)],
        "Customer returned",
        false,
        key("rf"),
      );
    // Refunding more than a third of the paid line is refused; exactly the pro-rata amount passes.
    expect((await attempt(go(1, 100))).ok).toBe(false);
    expect((await attempt(go(1, 96.67))).ok).toBe(true);
    expect((await attempt(go(1, 96.66))).ok).toBe(true);
    expect((await attempt(go(1, 96.67))).ok).toBe(true);
    expect(
      Number(
        await val(
          sql`SELECT COALESCE(SUM(amount),0) FROM public.pos_refunds WHERE sale_id = ${s.sale_id}`,
        ),
      ),
    ).toBe(290);
    expect(await val(sql`SELECT status FROM public.pos_sales WHERE id = ${s.sale_id}`)).toBe(
      "refunded",
    );
  });
});
