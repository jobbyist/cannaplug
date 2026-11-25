import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DB_URL,
  advanceOrder,
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
  placeOrder,
  receive,
  rpc,
  sell,
  stockOf,
  val,
  type Sql,
} from "./helpers";

/** 25 Nov 2026: exact decimal stock (0.1 g) for weighed products; whole units for everything else. */
describe.skipIf(!DB_URL)("decimal stock (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
  });
  beforeEach(async () => {
    // One open count at a time: close anything another test file left open.
    await sql`UPDATE public.stock_takes SET status = 'cancelled', closed_by = ${manager}, closed_at = now()
              WHERE status = 'open'`;
  });
  afterAll(async () => {
    await sql`UPDATE public.purchase_limits SET enabled = false WHERE category = 'Concentrates'`;
    await sql.end();
  });

  /** A product sold by weight (grams) in steps of `step` g. */
  const weighed = async (price = 24, step = 1, category = "Flower") => {
    const id = await mkProduct(sql, price);
    await sql`UPDATE public.products SET sold_by_weight = true, weight_step_g = ${step}, category = ${category}
              WHERE id = ${id}`;
    return id;
  };
  const onHand = async (p: string) => Number(await val(sql`SELECT public._product_on_hand(${p})`));
  const batchQty = async (id: string) =>
    Number(await val(sql`SELECT qty_on_hand FROM public.inventory_batches WHERE id = ${id}`));
  const till = async () => (await mkSession(sql, manager, cashier)).sessionId;

  it("a weighed product holds stock to one decimal exactly, with no floating-point drift", async () => {
    const p = await weighed();
    await receive(sql, manager, p, 27.4);
    expect(await onHand(p)).toBe(27.4);
    expect((await stockOf(sql, p)).available).toBe(27.4);

    const q = await weighed();
    for (let i = 0; i < 3; i++) await receive(sql, manager, q, 0.1);
    expect(await onHand(q)).toBe(0.3);
    await rpc(sql, "stock_quick_adjust", manager, q, -0.3, "Sample", key("qa"));
    expect(await onHand(q)).toBe(0);
    await assertInventoryConsistent(sql);
  });

  it("refuses more than one decimal, and any decimal for a product counted in whole units, on every entry point", async () => {
    const w = await weighed();
    const unit = await mkProduct(sql, 20);
    await receive(sql, manager, unit, 5);
    const batch = await receive(sql, manager, unit, 1);
    const wb = await receive(sql, manager, w, 5);

    const refused = async (p: Promise<unknown>) => failedWith(await attempt(p), "invalid_quantity");
    const take = (await rpc(sql, "stock_take_start", manager, null, null, key("st"))).stock_take_id;
    try {
      // too many decimals, even for a weighed product
      expect(
        await refused(
          rpc(sql, "receive_stock", manager, w, "X1", 27.45, null, null, null, key("r")),
        ),
      ).toBe(true);
      expect(await refused(rpc(sql, "adjust_stock", manager, wb, 0.25, "Too fine", key("a")))).toBe(
        true,
      );
      expect(
        await refused(rpc(sql, "stock_quick_adjust", manager, w, 1.05, "Too fine", key("q"))),
      ).toBe(true);
      expect(
        await refused(rpc(sql, "stock_take_record_count", cashier, take, w, 3.25, key("c"))),
      ).toBe(true);
      // decimals for a whole-unit product
      expect(
        await refused(
          rpc(sql, "receive_stock", manager, unit, "X2", 2.5, null, null, null, key("r")),
        ),
      ).toBe(true);
      expect(
        await refused(rpc(sql, "adjust_stock", manager, batch, 2.5, "Half a tube", key("a"))),
      ).toBe(true);
      expect(
        await refused(rpc(sql, "stock_quick_adjust", manager, unit, -1.5, "Half a tube", key("q"))),
      ).toBe(true);
      expect(
        await refused(rpc(sql, "stock_take_record_count", cashier, take, unit, 2.5, key("c"))),
      ).toBe(true);
      expect(
        await refused(
          rpc(
            sql,
            "stock_receive_delivery",
            manager,
            null,
            null,
            [{ product_id: unit, quantity: 2.5 }],
            key("d"),
          ),
        ),
      ).toBe(true);
    } finally {
      await rpc(sql, "stock_take_cancel", manager, take, key("sc"));
    }
    expect(await onHand(unit)).toBe(6);
    expect(await onHand(w)).toBe(5);
    // whole numbers and exact decimals are fine
    await rpc(sql, "stock_quick_adjust", manager, unit, -2, "Damaged", key("q"));
    await rpc(sql, "stock_quick_adjust", manager, w, 0.5, "Found", key("q"));
    expect(await onHand(unit)).toBe(4);
    expect(await onHand(w)).toBe(5.5);
  });

  it("quick remove spans batches first-expiring first and add goes to the newest batch, in decimals", async () => {
    const p = await weighed();
    const late = await receive(sql, manager, p, 20, "LATE", new Date(Date.now() + 60 * 86400_000));
    const early = await receive(
      sql,
      manager,
      p,
      10.5,
      "EARLY",
      new Date(Date.now() + 5 * 86400_000),
    );
    const r = await rpc(sql, "stock_quick_adjust", manager, p, -12.3, "Jar spill", key("qa"));
    expect([Number(r.before), Number(r.after)]).toEqual([30.5, 18.2]);
    expect([await batchQty(early), await batchQty(late)]).toEqual([0, 18.2]);
    await rpc(sql, "stock_quick_adjust", manager, p, 0.8, "Found", key("qa"));
    expect(await onHand(p)).toBe(19);
    await assertInventoryConsistent(sql);
  });

  it("a stock take counts and posts decimals exactly, and the difference is exact", async () => {
    const p = await weighed();
    await receive(sql, manager, p, 30);
    const t = (await rpc(sql, "stock_take_start", manager, null, null, key("st"))).stock_take_id;
    const c = await rpc(sql, "stock_take_record_count", cashier, t, p, 27.4, key("c"));
    expect([Number(c.expected), Number(c.counted), Number(c.difference)]).toEqual([30, 27.4, -2.6]);
    const posted = await rpc(sql, "stock_take_post", manager, t, key("post"));
    expect(Number(posted.units_removed)).toBe(2.6);
    expect(Number(posted.units_added)).toBe(0);
    expect(await onHand(p)).toBe(27.4);
    const [line] =
      await sql`SELECT counted_qty, expected_at_count, posted_delta FROM public.stock_take_lines
                             WHERE stock_take_id = ${t}`;
    expect([
      Number(line!["counted_qty"]),
      Number(line!["expected_at_count"]),
      Number(line!["posted_delta"]),
    ]).toEqual([27.4, 30, -2.6]);
    // counted again over: +0.7
    const t2 = (await rpc(sql, "stock_take_start", manager, null, null, key("st"))).stock_take_id;
    await rpc(sql, "stock_take_record_count", cashier, t2, p, 28.1, key("c"));
    await rpc(sql, "stock_take_post", manager, t2, key("post"));
    expect(await onHand(p)).toBe(28.1);
    await assertInventoryConsistent(sql);
  });

  it("a delivery with decimals is all-or-nothing", async () => {
    const w = await weighed();
    const unit = await mkProduct(sql, 20);
    const bad = await attempt(
      rpc(
        sql,
        "stock_receive_delivery",
        manager,
        "Grower",
        "INV-DEC-1",
        [
          { product_id: w, quantity: 12.5 },
          { product_id: unit, quantity: 2.5 },
        ],
        key("d"),
      ),
    );
    expect(failedWith(bad, "invalid_quantity")).toBe(true);
    expect(await onHand(w)).toBe(0);
    const ok = await rpc(
      sql,
      "stock_receive_delivery",
      manager,
      "Grower",
      "INV-DEC-2",
      [
        { product_id: w, quantity: 12.5 },
        { product_id: unit, quantity: 3 },
      ],
      key("d"),
    );
    expect(Number(ok.units)).toBe(15.5);
    expect(await onHand(w)).toBe(12.5);
  });

  it("the till sells a weighed product in its own step and prices the line to the cent", async () => {
    const p = await weighed(24.55, 0.5);
    await receive(sql, manager, p, 10);
    const session = await till();
    // 24.55 x 1.5 = 36.825 -> R36.83 (half up)
    const sale = await sell(
      sql,
      cashier,
      session,
      [{ product_id: p, quantity: 1.5 }],
      [cash("36.83")],
    );
    expect(Number(sale.total)).toBe(36.83);
    const [line] =
      await sql`SELECT quantity, line_total FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
    expect([Number(line!["quantity"]), Number(line!["line_total"])]).toEqual([1.5, 36.83]);
    expect(await onHand(p)).toBe(8.5);
    // wrong tender is still refused
    expect(
      failedWith(
        await attempt(
          sell(sql, cashier, session, [{ product_id: p, quantity: 1.5 }], [cash("36.82")]),
        ),
        "tender_mismatch",
      ),
    ).toBe(true);
    // not a multiple of the step
    expect(
      failedWith(
        await attempt(
          sell(sql, cashier, session, [{ product_id: p, quantity: 0.3 }], [cash("7.37")]),
        ),
        "invalid_batch_size",
      ),
    ).toBe(true);
    // a product sold in whole grams or whole units refuses a decimal quantity
    const grams = await weighed(24, 1);
    const unit = await mkProduct(sql, 20);
    await receive(sql, manager, grams, 10);
    await receive(sql, manager, unit, 10);
    // (1.5 x R24 = R36 and 1.5 x R20 = R30: the tender is right, so it is the step rule that refuses)
    for (const [id, tender] of [
      [grams, 36],
      [unit, 30],
    ] as const)
      expect(
        failedWith(
          await attempt(
            sell(sql, cashier, session, [{ product_id: id, quantity: 1.5 }], [cash(tender)]),
          ),
          "invalid_batch_size",
        ),
      ).toBe(true);
    // more than one decimal never gets past validation
    expect(
      failedWith(
        await attempt(sell(sql, cashier, session, [{ product_id: p, quantity: 1.25 }], [cash(30)])),
        "invalid_items",
      ),
    ).toBe(true);
    await assertInventoryConsistent(sql);
  });

  it("voiding a decimal sale puts back exactly what was taken, across batches", async () => {
    const p = await weighed(24, 0.5);
    const early = await receive(
      sql,
      manager,
      p,
      1.5,
      "EARLY",
      new Date(Date.now() + 5 * 86400_000),
    );
    const late = await receive(sql, manager, p, 10, "LATE", new Date(Date.now() + 60 * 86400_000));
    const session = await till();
    const sale = await sell(sql, cashier, session, [{ product_id: p, quantity: 3.5 }], [cash(84)]);
    expect([await batchQty(early), await batchQty(late)]).toEqual([0, 8]);
    await rpc(sql, "pos_void_sale", manager, sale.sale_id, "rang up twice", key("void"));
    expect([await batchQty(early), await batchQty(late)]).toEqual([1.5, 10]);
    await assertInventoryConsistent(sql);
  });

  it("a part refund of a decimal line returns the right amount and the right stock", async () => {
    const p = await weighed(24.55, 0.5);
    await receive(sql, manager, p, 10);
    const session = await till();
    const sale = await sell(
      sql,
      cashier,
      session,
      [{ product_id: p, quantity: 2 }],
      [cash("49.10")],
    );
    const [item] = await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
    // 49.10 x 0.5 / 2 = 12.275 -> R12.28
    await rpc(
      sql,
      "pos_refund_sale",
      manager,
      sale.sale_id,
      session,
      [{ sale_item_id: item!["id"], quantity: 0.5 }],
      [{ method: "cash", amount: "12.28" }],
      "Customer returned half a gram",
      true,
      key("rf"),
    );
    expect(await onHand(p)).toBe(8.5);
    const [after] =
      await sql`SELECT refunded_quantity FROM public.pos_sale_items WHERE id = ${item!["id"]}`;
    expect(Number(after!["refunded_quantity"])).toBe(0.5);
    // refunding more than was bought is refused
    expect(
      (
        await attempt(
          rpc(
            sql,
            "pos_refund_sale",
            manager,
            sale.sale_id,
            session,
            [{ sale_item_id: item!["id"], quantity: 1.6 }],
            [{ method: "cash", amount: "39.28" }],
            "Too much",
            true,
            key("rf"),
          ),
        )
      ).ok,
    ).toBe(false);
    await assertInventoryConsistent(sql);
  });

  it("a product sold in whole units can only be refunded in whole units", async () => {
    const unit = await mkProduct(sql, 20);
    await receive(sql, manager, unit, 10);
    const session = await till();
    const sale = await sell(sql, cashier, session, [{ product_id: unit, quantity: 2 }], [cash(40)]);
    const [item] = await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
    const half = await attempt(
      rpc(
        sql,
        "pos_refund_sale",
        manager,
        sale.sale_id,
        session,
        [{ sale_item_id: item!["id"], quantity: 0.5 }],
        [{ method: "cash", amount: "5" }],
        "Half a tube",
        true,
        key("rf"),
      ),
    );
    expect(failedWith(half, "invalid_quantity")).toBe(true);
    expect(await onHand(unit)).toBe(8);
    await rpc(
      sql,
      "pos_refund_sale",
      manager,
      sale.sale_id,
      session,
      [{ sale_item_id: item!["id"], quantity: 1 }],
      [{ method: "cash", amount: "20" }],
      "One tube",
      true,
      key("rf"),
    );
    expect(await onHand(unit)).toBe(9);
    await assertInventoryConsistent(sql);
  });

  it("online orders hold, consume and give back decimal stock, and total the rounded lines", async () => {
    const p = await weighed(24.55, 0.5);
    await receive(sql, manager, p, 10);
    const member = await mkMember(sql);
    const { orderId, total } = await placeOrder(sql, member, [{ product_id: p, quantity: 1.5 }]);
    expect(total).toBe(36.83);
    expect(await stockOf(sql, p)).toMatchObject({ on_hand: 10, held: 1.5, available: 8.5 });
    await advanceOrder(sql, manager, orderId, "confirmed");
    expect(await stockOf(sql, p)).toMatchObject({ on_hand: 8.5, held: 0, available: 8.5 });
    await rpc(sql, "transition_order_status", orderId, "cancelled", manager, null);
    expect(await stockOf(sql, p)).toMatchObject({ on_hand: 10, held: 0, available: 10 });
    // not a multiple of the step / too many decimals
    expect(
      failedWith(
        await attempt(placeOrder(sql, member, [{ product_id: p, quantity: 0.3 }])),
        "invalid_batch_size",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(placeOrder(sql, member, [{ product_id: p, quantity: 1.25 }])),
        "invalid_items",
      ),
    ).toBe(true);
    await assertInventoryConsistent(sql);
  });

  it("a daily limit in grams counts decimals exactly, online and at the till together", async () => {
    const admin = await mkUser(sql, "admin");
    const p = await weighed(24, 0.5, "Concentrates");
    await receive(sql, manager, p, 20);
    const member = await mkMember(sql);
    const session = await till();
    await rpc(sql, "purchase_limit_set", admin, "Concentrates", 3, true, key("lim"));
    try {
      await placeOrder(sql, member, [{ product_id: p, quantity: 1.5 }]);
      await sell(sql, cashier, session, [{ product_id: p, quantity: 1.5 }], [cash(36)], {
        customer: member,
      });
      // exactly 3.0 g so far: another half gram goes over
      const over = await attempt(placeOrder(sql, member, [{ product_id: p, quantity: 0.5 }]));
      expect(failedWith(over, "purchase_limit_exceeded")).toBe(true);
    } finally {
      await rpc(sql, "purchase_limit_set", admin, "Concentrates", 3, false, key("lim"));
    }
  });

  it("the stock views and helpers return decimals", async () => {
    const p = await weighed();
    await receive(sql, manager, p, 12.3);
    expect(Number(await val(sql`SELECT public._product_available(${p})`))).toBe(12.3);
    const [v] =
      await sql`SELECT on_hand, held, available, consumed, batches FROM public.inventory_availability
                          WHERE product_id = ${p}`;
    expect([Number(v!["on_hand"]), Number(v!["available"]), Number(v!["batches"])]).toEqual([
      12.3, 12.3, 1,
    ]);
    const [m] =
      await sql`SELECT quantity_delta FROM public.stock_movements WHERE product_id = ${p}`;
    expect(Number(m!["quantity_delta"])).toBe(12.3);
    // browsers can read the views but hold nothing else on them
    const grants = await sql`SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_name = 'inventory_availability' AND grantee = 'authenticated'`;
    expect(grants.map((g) => g["privilege_type"])).toEqual(["SELECT"]);
  });

  it("mutation check: without the whole-unit rule a pre-roll could be received as 2.5", async () => {
    const unit = await mkProduct(sql, 20);
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] =
          await tx`SELECT pg_get_functiondef('public._assert_stock_qty(uuid,numeric)'::regprocedure) AS d`;
        const broken = String(def!["d"]).replace("IF NOT v_weight THEN", "IF false THEN");
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        const o = await attempt(
          Promise.resolve(
            tx.unsafe(
              `SELECT public.receive_stock('${manager}', '${unit}', 'MUT', 2.5, null, null, null, '${key("mut")}')`,
            ),
          ),
        );
        expect(o.ok).toBe(true);
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
    expect(await onHand(unit)).toBe(0);
    expect(
      failedWith(
        await attempt(
          rpc(sql, "receive_stock", manager, unit, "REAL", 2.5, null, null, null, key("r")),
        ),
        "invalid_quantity",
      ),
    ).toBe(true);
  });
});
