import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  attempt,
  cash,
  connect,
  failedWith,
  key,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  stockOf,
  val,
  type Sql,
} from "./helpers";

const PLACEHOLDER = "00000000-0000-4000-8000-00000000c057";

/** 8 Nov 2026: custom items at the till: typed name and price, this sale only, never a product, never stock. */
describe.skipIf(!DB_URL)("POS custom items (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => {
    await sql.end();
  });

  const till = async () => {
    const cashier = await mkUser(sql, "budtender");
    const { sessionId } = await mkSession(sql, manager, cashier);
    return { cashier, sessionId };
  };
  const custom = (name: string, price: string, quantity = 1, extra: object = {}) => ({
    custom: { name, price },
    quantity,
    ...extra,
  });
  const productCount = () => val<number>(sql`SELECT count(*)::int FROM public.products`);

  it("a custom line is sold at the typed price, stored on the sale only, with no stock and an audit row", async () => {
    const { cashier, sessionId } = await till();
    const before = await productCount();
    const sale = await sell(
      sql,
      cashier,
      sessionId,
      [custom("Gift wrapping", "15.50", 2)],
      [cash(31)],
    );
    expect(sale).toMatchObject({ total: 31 });
    expect(sale.items).toEqual([
      expect.objectContaining({
        name: "Gift wrapping",
        quantity: 2,
        unit_price: 15.5,
        line_total: 31,
        is_custom: true,
      }),
    ]);
    expect(await productCount()).toBe(before);
    const [line] =
      await sql`SELECT id, product_id, is_custom FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
    expect(line).toMatchObject({ product_id: PLACEHOLDER, is_custom: true });
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.inventory_ledger WHERE reference_id = ${line!["id"]}`,
      ),
    ).toBe(0);
    const [audit] = await sql`SELECT actor_user_id, metadata FROM public.audit_log
                              WHERE action = 'pos_custom_item_sold' AND entity_id = ${sale.sale_id}`;
    expect(audit!["actor_user_id"]).toBe(cashier);
    expect((audit!["metadata"] as { items: unknown[] }).items).toEqual([
      { name: "Gift wrapping", unit_price: 15.5, quantity: 2, line_total: 31 },
    ]);
    await assertInventoryConsistent(sql);
  });

  it("two custom lines and a product on one sale, with line and order discounts shared to the cent", async () => {
    const { cashier, sessionId } = await till();
    const p = await mkProduct(sql, 100);
    await receive(sql, manager, p, 5);
    const sale = await sell(
      sql,
      cashier,
      sessionId,
      [
        custom("Delivery", "30"),
        custom("Delivery", "30"), // same name twice stays two lines
        custom("Engraving", "10", 1, { discount: { kind: "percent", value: "50" } }),
        { product_id: p, quantity: 1 },
      ],
      [cash("148.50")],
      { orderDiscount: { kind: "percent", value: "10" }, reason: "loyal customer" },
    );
    // 30 + 30 + 5 + 100 = 165; 10% off = 148.50
    expect(Number(sale.total)).toBe(148.5);
    const lines = await sql`SELECT product_name, is_custom, line_total FROM public.pos_sale_items
                            WHERE sale_id = ${sale.sale_id} ORDER BY product_name, line_total`;
    expect(lines.filter((l) => l["is_custom"])).toHaveLength(3);
    expect(lines.reduce((s, l) => s + Number(l["line_total"]), 0)).toBeCloseTo(148.5, 2);
    expect((await stockOf(sql, p)).on_hand).toBe(4);
    await assertInventoryConsistent(sql);
  });

  it("a sale with custom lines can be voided and refunded; only real stock goes back", async () => {
    const { cashier, sessionId } = await till();
    const p = await mkProduct(sql, 40);
    await receive(sql, manager, p, 3);
    const a = await sell(
      sql,
      cashier,
      sessionId,
      [custom("Lighter refill", "20"), { product_id: p, quantity: 1 }],
      [cash(60)],
    );
    await rpc(sql, "pos_void_sale", manager, a.sale_id, "rang up twice", key("void"));
    expect((await stockOf(sql, p)).on_hand).toBe(3);

    const b = await sell(sql, cashier, sessionId, [custom("Lighter refill", "20", 2)], [cash(40)]);
    const [line] = await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${b.sale_id}`;
    await rpc(
      sql,
      "pos_refund_sale",
      manager,
      b.sale_id,
      sessionId,
      [{ sale_item_id: line!["id"], quantity: 1 }],
      [{ method: "cash", amount: "20" }],
      "returned",
      true,
      key("rf"),
    );
    const [after] =
      await sql`SELECT refunded_quantity FROM public.pos_sale_items WHERE id = ${line!["id"]}`;
    expect(after!["refunded_quantity"]).toBe(1);
    await assertInventoryConsistent(sql);
  });

  it("a member earns loyalty on a sale with a custom line without errors", async () => {
    const { cashier, sessionId } = await till();
    const member = await mkMember(sql);
    const sale = await sell(
      sql,
      cashier,
      sessionId,
      [custom("Workshop ticket", "200")],
      [cash(200)],
      {
        customer: member,
      },
    );
    expect((await attempt(rpc(sql, "accrue_pos_loyalty", sale.sale_id))).ok).toBe(true);
  });

  it("refuses bad custom lines and the placeholder as a normal product", async () => {
    const { cashier, sessionId } = await till();
    const bad = [
      custom("X", "10"), // name too short
      custom("A".repeat(81), "10"),
      custom("Gift\nwrap", "10"),
      custom("Gift wrap", "0"),
      custom("Gift wrap", "-5"),
      custom("Gift wrap", "10.505"),
      custom("Gift wrap", "100000.01"),
      custom("Gift wrap", "ten"),
      { ...custom("Gift wrap", "10"), product_id: PLACEHOLDER },
      { ...custom("Gift wrap", "10"), reward: "greenhouse_free" },
      { custom: "Gift wrap", quantity: 1 },
    ];
    for (const item of bad) {
      const o = await attempt(sell(sql, cashier, sessionId, [item as never], [cash(10)]));
      expect(failedWith(o, "invalid_items"), JSON.stringify(item)).toBe(true);
    }
    expect(
      failedWith(
        await attempt(
          sell(sql, cashier, sessionId, [{ product_id: PLACEHOLDER, quantity: 1 }], [cash(1)]),
        ),
        "product_unavailable",
      ),
    ).toBe(true);
    // The total is still the server's: a wrong tender is refused.
    expect(
      failedWith(
        await attempt(sell(sql, cashier, sessionId, [custom("Gift wrap", "10")], [cash(9)])),
        "tender_mismatch",
      ),
    ).toBe(true);
    const [p] =
      await sql`SELECT is_active, track_stock, sell_online FROM public.products WHERE id = ${PLACEHOLDER}`;
    expect(p).toEqual({ is_active: false, track_stock: false, sell_online: false });
  });

  it("the one-line-per-product rule still covers catalogue lines (custom lines excepted)", async () => {
    const p = await mkProduct(sql, 10);
    await receive(sql, manager, p, 5);
    const o = await attempt(
      Promise.resolve(
        sql`SELECT count(*) FROM pg_indexes WHERE indexname = 'pos_sale_items_one_line_per_product'`,
      ),
    );
    expect(o.ok).toBe(true);
    const fake =
      await sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'pos_sale_items_one_line_per_product'`;
    expect(String(fake[0]!["indexdef"])).toMatch(/WHERE \(NOT is_custom\)/);
  });

  it("the placeholder is locked: it can't be switched on, edited, priced or deleted", async () => {
    for (const q of [
      sql`UPDATE public.products SET is_active = true WHERE id = ${PLACEHOLDER}`,
      sql`UPDATE public.products SET price_rand = 1, sell_online = true WHERE id = ${PLACEHOLDER}`,
      sql`DELETE FROM public.products WHERE id = ${PLACEHOLDER}`,
    ]) {
      expect(failedWith(await attempt(Promise.resolve(q)), "custom_item_placeholder_locked")).toBe(
        true,
      );
    }
    const [p] =
      await sql`SELECT is_active, price_rand FROM public.products WHERE id = ${PLACEHOLDER}`;
    expect(p).toMatchObject({ is_active: false });
    // Other products are not affected.
    const other = await mkProduct(sql, 10);
    await sql`UPDATE public.products SET is_active = false WHERE id = ${other}`;
  });

  it("mutation check: without the custom-line skip, the till would try to take placeholder stock", async () => {
    const { cashier, sessionId } = await till();
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] = await tx`SELECT pg_get_functiondef(
          'public.pos_complete_sale(uuid,uuid,jsonb,jsonb,uuid,text,jsonb,text)'::regprocedure) AS d`;
        const broken = String(def!["d"]).replace("CONTINUE WHEN v_line.is_custom;", "");
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        const o = await attempt(
          Promise.resolve(
            tx.unsafe(
              `SELECT public.pos_complete_sale('${cashier}', '${sessionId}',
                 '[{"custom":{"name":"Gift wrap","price":"10"},"quantity":1}]'::jsonb,
                 '[{"method":"cash","amount":"10"}]'::jsonb, null, '${key("mut")}')`,
            ),
          ),
        );
        expect(o.ok).toBe(false);
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect(
      (await sell(sql, cashier, sessionId, [custom("Gift wrap", "10")], [cash(10)])).total,
    ).toBe(10);
  });
});
