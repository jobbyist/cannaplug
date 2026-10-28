import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  attempt,
  cash,
  connect,
  earnPoints,
  key,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  val,
  verifyDirect,
  type Role,
  type Sql,
} from "./helpers";

/** Staff purchases: 20% off, automatically, in store and online, flagged for reports — real PostgreSQL. */
describe.skipIf(!DB_URL)("staff purchases (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let sessionId: string;

  beforeAll(async () => {
    sql = connect(20);
    manager = await mkUser(sql, "manager");
    // A manager runs this till: managers can attach any staff member (the attach rules are tested in staff-rules).
    cashier = await mkUser(sql, "manager");
    ({ sessionId } = await mkSession(sql, manager, cashier));
  });
  afterAll(async () => {
    await sql.end();
  });

  const product = async (price: number, stock = 50) => {
    const id = await mkProduct(sql, price);
    await receive(sql, manager, id, stock);
    return id;
  };
  /** A staff member who has also verified their ID (needed to order online, as for every member). */
  const staffMember = async (role: Role) => {
    const id = await mkUser(sql, role);
    await verifyDirect(sql, id);
    return id;
  };
  const saleRow = async (saleId: string) =>
    (
      await sql`SELECT staff_purchase, staff_discount_rand, discount_rand, discount_reason, total
                FROM public.pos_sales WHERE id = ${saleId}`
    )[0]!;
  const placeOnline = (user: string, items: unknown, total: number | null) =>
    rpc(
      sql,
      "checkout_place_order",
      user,
      items,
      "Test Person",
      "+27 82 000 0000",
      "collection",
      null,
      "eft",
      total,
      null,
      key("co"),
    );

  it("the rate is 20% and only budtenders, managers and admins are staff", async () => {
    expect(Number(await rpc(sql, "staff_purchase_percent"))).toBe(20);
    for (const role of ["budtender", "manager", "admin"] as const)
      expect(await rpc(sql, "_is_staff", await mkUser(sql, role))).toBe(true);
    expect(await rpc(sql, "_is_staff", await mkUser(sql, "customer"))).toBe(false);
    expect(await rpc(sql, "_is_staff", null)).toBe(false);
  });

  describe("in store", () => {
    it.each(["budtender", "manager", "admin"] as const)(
      "a %s on the sale gets 20% off automatically, with no reason typed, and it is audited",
      async (role) => {
        const staff = await mkUser(sql, role);
        const p = await product(100);
        const s = await sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: p, quantity: 2 }],
          [cash(160)],
          {
            customer: staff,
          },
        );
        expect(Number(s.total)).toBe(160);
        expect(Number(s.discount)).toBe(40);
        expect(s.staff_purchase).toBe(true);
        expect(await saleRow(s.sale_id)).toMatchObject({
          staff_purchase: true,
          discount_reason: "Staff purchase (20% off)",
        });
        expect(Number((await saleRow(s.sale_id))["staff_discount_rand"])).toBe(40);
        expect(
          await val(
            sql`SELECT metadata->>'staff_purchase' FROM public.audit_log
                WHERE action = 'pos_sale_discount' AND entity_id = ${s.sale_id}`,
          ),
        ).toBe("true");
      },
    );

    it("the tender must equal the discounted total, and a member or walk-in pays full price", async () => {
      const staff = await mkUser(sql, "budtender");
      const p = await product(100);
      const wrong = await attempt(
        sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(100)], {
          customer: staff,
        }),
      );
      expect(wrong.ok).toBe(false);
      const member = await mkMember(sql);
      const m = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(100)], {
        customer: member,
      });
      expect(m.staff_purchase).toBe(false);
      expect(Number(m.total)).toBe(100);
      const w = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(100)]);
      expect(w.staff_purchase).toBe(false);
      expect((await saleRow(w.sale_id))["staff_purchase"]).toBe(false);
    });

    it("works on top of line discounts (which still need a reason) and is not stacked on a manual order discount", async () => {
      const staff = await mkUser(sql, "manager");
      const p = await product(100);
      // 10% line discount first: 200 -> 180, then staff 20% of 180 = 36 -> 144
      const line = (reason: string | null) =>
        attempt(
          sell(
            sql,
            cashier,
            sessionId,
            [{ product_id: p, quantity: 2, discount: { kind: "percent", value: "10" } }],
            [cash(144)],
            { customer: staff, reason },
          ),
        );
      expect((await line(null)).ok).toBe(false); // the manual line discount still needs its reason
      expect((await line("Damaged tin")).ok).toBe(true);
      // a smaller manual order discount (10% = R20) is covered by the staff rate (R40): total 160
      const small = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: p, quantity: 2 }],
        [cash(160)],
        {
          customer: staff,
          orderDiscount: { kind: "percent", value: "10" },
          reason: "Loyal",
        },
      );
      expect(Number(small.discount)).toBe(40);
      // a larger one (30% = R60) wins: total 140, still flagged as a staff purchase
      const big = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: p, quantity: 2 }],
        [cash(140)],
        {
          customer: staff,
          orderDiscount: { kind: "percent", value: "30" },
          reason: "Owner approved",
        },
      );
      expect(Number(big.discount)).toBe(60);
      expect(await saleRow(big.sale_id)).toMatchObject({ staff_purchase: true });
      expect(Number((await saleRow(big.sale_id))["staff_discount_rand"])).toBe(40);
      expect(
        (
          await attempt(
            sell(sql, cashier, sessionId, [{ product_id: p, quantity: 2 }], [cash(140)], {
              customer: staff,
              orderDiscount: { kind: "percent", value: "30" },
            }),
          )
        ).ok,
      ).toBe(false); // a manual discount still needs a reason
    });

    it("refunds give back what the staff member actually paid, pro-rata", async () => {
      const staff = await mkUser(sql, "budtender");
      const p = await product(100);
      const s = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 2 }], [cash(160)], {
        customer: staff,
      });
      const itemId = await val<string>(
        sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${s.sale_id}`,
      );
      const go = (amount: number) =>
        rpc(
          sql,
          "pos_refund_sale",
          manager,
          s.sale_id,
          sessionId,
          [{ sale_item_id: itemId, quantity: 1 }],
          [cash(amount)],
          "Returned",
          false,
          key("rf"),
        );
      expect((await attempt(go(100))).ok).toBe(false); // not the full-price figure
      expect((await attempt(go(80))).ok).toBe(true);
    });

    it("the till's customer search includes staff and says which are staff; it is for staff only", async () => {
      const staff = await mkUser(sql, "budtender");
      const tag = `zz${key("n").slice(-8)}`;
      await sql`INSERT INTO public.profiles (id, full_name) VALUES (${staff}, ${`${tag} Staff`})
                ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name`;
      const member = await mkMember(sql);
      await sql`INSERT INTO public.profiles (id, full_name) VALUES (${member}, ${`${tag} Member`})
                ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name`;
      const rows = await rpc<{ id: string; is_staff: boolean }[]>(
        sql,
        "pos_customer_search",
        cashier,
        tag,
        10,
      );
      expect(rows.find((r) => r.id === staff)?.is_staff).toBe(true);
      expect(rows.find((r) => r.id === member)?.is_staff).toBe(false);
      expect(await rpc(sql, "pos_customer_search", cashier, "z", 10)).toEqual([]);
      expect((await attempt(rpc(sql, "pos_customer_search", member, tag, 10))).ok).toBe(false);
    });
  });

  describe("online", () => {
    it("the quote shows the staff rate for staff and not for members", async () => {
      const p = await product(100);
      const items = [{ product_id: p, quantity: 2 }];
      const staff = await staffMember("manager");
      const member = await mkMember(sql);
      const sq = await rpc(sql, "checkout_quote_for", staff, items, "standard");
      expect(sq).toMatchObject({
        staff_purchase: true,
        staff_percent: 20,
        staff_discount: 40,
        subtotal: 200,
        delivery_fee: 80,
        total: 240,
      });
      expect(await rpc(sql, "checkout_quote_for", member, items, "standard")).toMatchObject({
        staff_purchase: false,
        staff_discount: 0,
        total: 280,
      });
      // not orderable -> no total, no discount maths on null
      const short = [{ product_id: p, quantity: 999 }];
      expect(await rpc(sql, "checkout_quote_for", staff, short, "standard")).toMatchObject({
        orderable: false,
        total: null,
      });
    });

    it.each(["budtender", "manager", "admin"] as const)(
      "a %s places an order with 20% off the goods (not the delivery), and pays that total",
      async (role) => {
        const staff = await staffMember(role);
        const p = await product(100);
        const items = [{ product_id: p, quantity: 2 }];
        // the browser's idea of the total must be the discounted one
        const stale = await attempt(
          rpc(
            sql,
            "checkout_place_order",
            staff,
            items,
            "T P",
            "+27 82 000 0000",
            "standard",
            null,
            "eft",
            280,
            null,
            key("co"),
          ),
        );
        expect(stale.ok).toBe(false);
        const addr = (
          await rpc(
            sql,
            "member_save_address",
            staff,
            null,
            { label: "Home", line1: "1 Long St", city: "Cape Town" },
            false,
          )
        ).id as string;
        const o = await rpc(
          sql,
          "checkout_place_order",
          staff,
          items,
          "T P",
          "+27 82 000 0000",
          "standard",
          addr,
          "eft",
          240,
          null,
          key("co"),
        );
        expect(o).toMatchObject({ total: 240, staff_purchase: true, staff_discount: 40 });
        const row = (
          await sql`SELECT staff_purchase, staff_discount_rand, delivery_fee_rand, total_rand
                    FROM public.orders WHERE id = ${o.order_id}`
        )[0]!;
        expect(row).toMatchObject({ staff_purchase: true });
        expect(Number(row["staff_discount_rand"])).toBe(40);
        expect(Number(row["total_rand"])).toBe(240);
        expect(Number(row["delivery_fee_rand"])).toBe(80);
        // order lines keep the normal price; payment must match the discounted total
        expect(
          Number(
            await val(
              sql`SELECT sum(unit_price_rand * quantity) FROM public.order_items WHERE order_id = ${o.order_id}`,
            ),
          ),
        ).toBe(200);
        expect(
          await rpc(sql, "confirm_order_payment", "eft", key("EFT"), o.order_id, 280),
        ).toMatchObject({ outcome: "amount_mismatch" });
        expect(
          await rpc(sql, "confirm_order_payment", "eft", key("EFT"), o.order_id, 240),
        ).toMatchObject({ outcome: "confirmed" });
      },
    );

    it("pickup orders get the rate too, and a member's order is unchanged", async () => {
      const staff = await staffMember("budtender");
      const member = await mkMember(sql);
      const p = await product(100);
      const items = [{ product_id: p, quantity: 1 }];
      expect(await placeOnline(staff, items, 80)).toMatchObject({
        total: 80,
        staff_purchase: true,
      });
      const m = await placeOnline(member, items, 100);
      expect(m).toMatchObject({ total: 100, staff_purchase: false, staff_discount: 0 });
    });

    it("loyalty points apply to what is left after the staff discount", async () => {
      const staff = await staffMember("manager");
      await earnPoints(sql, manager, staff, 500);
      const p = await product(400);
      const addr = (
        await rpc(
          sql,
          "member_save_address",
          staff,
          null,
          { label: "Home", line1: "1 Long St", city: "Cape Town" },
          false,
        )
      ).id as string;
      // goods 400 - staff 80 = 320, + delivery 80 = 400
      const o = await rpc(
        sql,
        "checkout_place_order",
        staff,
        [{ product_id: p, quantity: 1 }],
        "T P",
        "+27 82 000 0000",
        "standard",
        addr,
        "eft",
        400,
        null,
        key("co"),
      );
      expect(Number(o.total)).toBe(400);
      const red = await rpc(sql, "redeem_loyalty_points", staff, o.order_id, 200, key("r"));
      expect(red).toMatchObject({ discount: 20, total: 380 }); // 320 + 80 - 20
      const row = (
        await sql`SELECT total_rand, staff_discount_rand FROM public.orders WHERE id = ${o.order_id}`
      )[0]!;
      expect(Number(row["total_rand"])).toBe(380);
      expect(Number(row["staff_discount_rand"])).toBe(80); // the staff discount survives the redemption
    });
  });

  describe("reports", () => {
    it("the sales report has a staff section and flags each staff transaction", async () => {
      const staff = await mkUser(sql, "admin");
      const p = await product(100);
      const staffSale = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: p, quantity: 1 }],
        [cash(80)],
        {
          customer: staff,
        },
      );
      const plain = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: p, quantity: 1 }],
        [cash(100)],
      );
      const day = await val<string>(
        sql`SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYY-MM-DD')`,
      );
      const r = await rpc(sql, "sales_report", manager, day, day);
      expect(r.staff.percent).toBe(20);
      expect(r.staff.pos.count).toBeGreaterThanOrEqual(1);
      expect(Number(r.staff.discount)).toBeGreaterThanOrEqual(20);
      expect(Number(r.staff.total)).toBeGreaterThanOrEqual(80);
      const ref = async (id: string) =>
        await val<string>(sql`SELECT receipt_number FROM public.pos_sales WHERE id = ${id}`);
      const recent = r.recent as { ref: string; staff: boolean }[];
      expect(recent.find((x) => x.ref === (staffSale.receipt_number as string))?.staff).toBe(true);
      expect(recent.find((x) => x.ref === (plain.receipt_number as string))?.staff).toBe(false);
      expect(await ref(staffSale.sale_id)).toBe(staffSale.receipt_number);
      // the report is still staff-only
      expect((await attempt(rpc(sql, "sales_report", await mkMember(sql), day, day))).ok).toBe(
        false,
      );
    });
  });

  it("mutation check: if staff were not recognised, no discount would be given (the rule is what applies it)", async () => {
    const staff = await mkUser(sql, "budtender");
    const p = await product(100);
    const rolledBack = new Error("rollback");
    const result = await sql
      .begin(async (tx) => {
        await tx.unsafe(
          "CREATE OR REPLACE FUNCTION public._is_staff(p_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT false $$",
        );
        const s = await sell(
          tx as unknown as Sql,
          cashier,
          sessionId,
          [{ product_id: p, quantity: 1 }],
          [cash(100)],
          {
            customer: staff,
          },
        );
        expect(s.staff_purchase).toBe(false);
        expect(Number(s.total)).toBe(100);
        throw rolledBack;
      })
      .catch((e) => e);
    expect(result).toBe(rolledBack);
    // and with the real rule restored, the same sale is discounted
    const s = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(80)], {
      customer: staff,
    });
    expect(s.staff_purchase).toBe(true);
  });
});
