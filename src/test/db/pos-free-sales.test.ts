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
  type Sql,
} from "./helpers";

const pct = (value: string) => ({ kind: "percent", value });
const amt = (value: string) => ({ kind: "amount", value });

describe.skipIf(!DB_URL)(
  "any staff member can discount 0-100% and finish the sale (real PostgreSQL)",
  () => {
    let sql: Sql;
    let admin: string;
    let manager: string;
    let cashier: string;
    let a: string;
    let b: string;

    beforeAll(async () => {
      sql = connect(10);
      [admin, manager, cashier] = await Promise.all([
        mkUser(sql, "admin"),
        mkUser(sql, "manager"),
        mkUser(sql, "budtender"),
      ]);
      a = await mkProduct(sql, 120);
      b = await mkProduct(sql, 80);
      await receive(sql, manager, a, 500);
      await receive(sql, manager, b, 500);
    });
    afterAll(async () => {
      await sql.end();
    });

    const till = (who: string) => mkSession(sql, manager, who);
    const total = (r: { total: string | number }) => Number(r.total);

    it("a budtender, a manager and an admin can each discount any percentage with no approval", async () => {
      for (const who of [cashier, manager, admin]) {
        const { sessionId } = await till(who);
        for (const p of ["0.01", "1", "20.5", "50", "99.99"]) {
          const price = 120 * (1 - Number(p) / 100);
          const r = await sell(
            sql,
            who,
            sessionId,
            [{ product_id: a, quantity: 1, discount: pct(p) }],
            [cash(price.toFixed(2))],
            { reason: "loyal customer" },
          );
          expect(total(r)).toBeCloseTo(price, 2);
        }
      }
    });

    it("100% off one product: the sale completes at R0 with no payment, stock is taken, and it is audited", async () => {
      const { sessionId } = await till(cashier);
      const before = await stockOf(sql, a);
      const r = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: a, quantity: 2, discount: pct("100") }],
        [],
        { reason: "damaged packaging" },
      );
      expect(total(r)).toBe(0);
      expect(r.discount).toBe(240);
      expect(r.tenders).toEqual([]);
      expect(r.items[0]).toMatchObject({ line_total: 0, line_discount: 240 });
      expect(await stockOf(sql, a)).toEqual(
        expect.objectContaining({ available: before.available - 2 }),
      );
      const audit =
        await sql`SELECT metadata FROM public.audit_log WHERE action = 'pos_sale_discount' AND entity_id = ${r.sale_id}`;
      expect(audit[0]!["metadata"]).toMatchObject({ total: 0, reason: "damaged packaging" });
      const [sale] =
        await sql`SELECT total, discount_rand, discount_reason FROM public.pos_sales WHERE id = ${r.sale_id}`;
      expect(Number(sale!["total"])).toBe(0);
      expect(Number(sale!["discount_rand"])).toBe(240);
      await assertInventoryConsistent(sql);
    });

    it("100% off the whole order, 100% off every line, and both together all finish (no divide by zero)", async () => {
      const { sessionId } = await till(cashier);
      const items = [
        { product_id: a, quantity: 1 },
        { product_id: b, quantity: 3 },
      ];
      const order = await sell(sql, cashier, sessionId, items, [], {
        orderDiscount: pct("100"),
        reason: "owner's friend",
      });
      expect(total(order)).toBe(0);
      expect(order.items.map((i: { line_total: number }) => Number(i.line_total))).toEqual([0, 0]);
      const lines = await sell(
        sql,
        cashier,
        sessionId,
        items.map((i) => ({ ...i, discount: pct("100") })),
        [],
        { reason: "promotion" },
      );
      expect(total(lines)).toBe(0);
      const both = await sell(
        sql,
        cashier,
        sessionId,
        items.map((i) => ({ ...i, discount: pct("100") })),
        [],
        { orderDiscount: pct("50"), reason: "stacked" },
      );
      expect(total(both)).toBe(0);
      const amount = await sell(sql, cashier, sessionId, [{ product_id: a, quantity: 1 }], [], {
        orderDiscount: amt("120"),
        reason: "free sample",
      });
      expect(total(amount)).toBe(0);
    });

    it("a rand amount discount can equal but not exceed what it applies to; over 100% is refused", async () => {
      const { sessionId } = await till(cashier);
      const one = [{ product_id: a, quantity: 1 }];
      expect(
        failedWith(
          await attempt(
            sell(sql, cashier, sessionId, [{ ...one[0]!, discount: pct("100.01") }], [cash(1)], {
              reason: "typo",
            }),
          ),
          "invalid_discount",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(
            sell(sql, cashier, sessionId, [{ ...one[0]!, discount: amt("120.01") }], [], {
              reason: "too big",
            }),
          ),
          "discount_too_large",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(
            sell(sql, cashier, sessionId, one, [], {
              orderDiscount: amt("120.01"),
              reason: "too big",
            }),
          ),
          "discount_too_large",
        ),
      ).toBe(true);
    });

    it("the payments must still equal the total exactly: a free sale takes none, a paid one needs them", async () => {
      const { sessionId } = await till(cashier);
      const free = [{ product_id: a, quantity: 1, discount: pct("100") }];
      expect(
        failedWith(
          await attempt(sell(sql, cashier, sessionId, free, [cash(10)], { reason: "free" })),
          "tender_mismatch",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(sell(sql, cashier, sessionId, [{ product_id: a, quantity: 1 }], [])),
          "tender_mismatch",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(
            sell(
              sql,
              cashier,
              sessionId,
              [{ product_id: a, quantity: 1, discount: pct("50") }],
              [cash(59)],
              { reason: "half" },
            ),
          ),
          "tender_mismatch",
        ),
      ).toBe(true);
    });

    it("any discount, including 100%, still needs a reason", async () => {
      const { sessionId } = await till(cashier);
      expect(
        failedWith(
          await attempt(
            sell(
              sql,
              cashier,
              sessionId,
              [{ product_id: a, quantity: 1, discount: pct("100") }],
              [],
            ),
          ),
          "discount_reason_required",
        ),
      ).toBe(true);
      expect(
        failedWith(
          await attempt(
            sell(
              sql,
              cashier,
              sessionId,
              [{ product_id: a, quantity: 1, discount: pct("100") }],
              [],
              { reason: "x" },
            ),
          ),
          "discount_reason_required",
        ),
      ).toBe(true);
    });

    it("a free sale with a member attached still works for loyalty (no points, no error)", async () => {
      const { sessionId } = await till(cashier);
      const member = await mkMember(sql);
      const r = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: a, quantity: 1, discount: pct("100") }],
        [],
        { customer: member, reason: "loyalty gift" },
      );
      const out = await rpc(sql, "accrue_pos_loyalty", r.sale_id);
      expect(out.accrued).toBeDefined();
      const paid = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: a, quantity: 1, discount: pct("50") }],
        [cash(60)],
        { customer: member, reason: "half" },
      );
      expect(Number(paid.total)).toBe(60);
    });

    it("a free sale replays by idempotency key and does not touch the till's cash", async () => {
      const { sessionId } = await till(cashier);
      const k = key("free");
      const items = [{ product_id: b, quantity: 1, discount: pct("100") }];
      const first = await sell(sql, cashier, sessionId, items, [], { idem: k, reason: "free" });
      const again = await sell(sql, cashier, sessionId, items, [], { idem: k, reason: "free" });
      expect(again).toMatchObject({ sale_id: first.sale_id, replayed: true });
      const [s] =
        await sql`SELECT count(*)::int AS n FROM public.pos_sales WHERE session_id = ${sessionId}`;
      expect(s!["n"]).toBe(1);
      const tenders =
        await sql`SELECT count(*)::int AS n FROM public.pos_tenders WHERE sale_id = ${first.sale_id}`;
      expect(tenders[0]!["n"]).toBe(0);
    });

    it("a manager can void a free sale and the stock goes back; nothing is refundable on a free line", async () => {
      const { sessionId } = await till(manager);
      const before = await stockOf(sql, b);
      const r = await sell(
        sql,
        manager,
        sessionId,
        [{ product_id: b, quantity: 2, discount: pct("100") }],
        [],
        { reason: "free sample" },
      );
      expect((await stockOf(sql, b)).available).toBe(before.available - 2);
      const line = (
        await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${r.sale_id}`
      )[0]!["id"];
      const refund = await attempt(
        rpc(
          sql,
          "pos_refund_sale",
          manager,
          r.sale_id,
          sessionId,
          [{ sale_item_id: line, quantity: 1 }],
          [{ method: "cash", amount: "1" }],
          "returned",
          true,
          key("rf"),
        ),
      );
      expect(refund.ok).toBe(false);
      await rpc(sql, "pos_void_sale", manager, r.sale_id, "given in error", key("void"));
      expect((await stockOf(sql, b)).available).toBe(before.available);
      await assertInventoryConsistent(sql);
    });

    it("a free sale shows in the sales report as a discounted sale, with no money taken", async () => {
      const { sessionId } = await till(cashier);
      const day = new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
      const before = await rpc(sql, "sales_report", manager, day, day);
      await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: a, quantity: 1, discount: pct("100") }],
        [],
        { reason: "report check" },
      );
      const after = await rpc(sql, "sales_report", manager, day, day);
      expect(Number(after.pos.discounts) - Number(before.pos.discounts)).toBeGreaterThanOrEqual(
        120,
      );
      expect(Number(after.pos.gross)).toBeGreaterThanOrEqual(Number(before.pos.gross));
    });

    it("mutation check: with the old 'total above zero' rule back in place, a free sale is refused", async () => {
      const rolledBack = Symbol("rollback");
      const { sessionId } = await till(cashier);
      let refused = "";
      await sql
        .begin(async (tx) => {
          await tx`ALTER TABLE public.pos_sales ADD CONSTRAINT zz_old_total_rule CHECK (total > 0) NOT VALID`;
          try {
            await rpc(
              tx as unknown as Sql,
              "pos_complete_sale",
              cashier,
              sessionId,
              [{ product_id: a, quantity: 1, discount: pct("100") }],
              [],
              null,
              key("mut"),
              null,
              "mutation",
            );
          } catch (e) {
            refused = (e as Error).message;
          }
          throw rolledBack;
        })
        .catch((e) => {
          if (e !== rolledBack) throw e;
        });
      expect(refused).toContain("zz_old_total_rule");
    });
  },
);
