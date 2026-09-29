import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  attempt,
  card,
  cash,
  connect,
  failedWith,
  key,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  stockOf,
  uid,
  val,
  type Sql,
} from "./helpers";

/**
 * Scenarios from the Milestone 3 concurrency review brief that are not covered by
 * pos-concurrency.test.ts: money movements racing a till close, duplicate online orders,
 * cross-channel payment references, inventory-denial and housekeeping.
 */
describe.skipIf(!DB_URL)("Milestone 3 concurrency review scenarios (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;

  beforeAll(async () => {
    sql = connect(60);
    await Promise.all(Array.from({ length: 60 }, () => sql`SELECT pg_sleep(0.2)`));
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
  });

  const setup = async (qty = 50, price = 50) => {
    const product = await mkProduct(sql, price);
    await receive(sql, manager, product, qty);
    const { sessionId } = await mkSession(sql, manager, cashier, 300);
    return { product, sessionId };
  };

  describe("till close vs refunds / voids (cash expected must match committed money movements)", () => {
    it("a refund racing the close is either fully in the expected cash or cleanly refused — never half-counted", async () => {
      for (let round = 0; round < 8; round++) {
        const { product, sessionId } = await setup(10);
        const sale = await sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: product, quantity: 2 }],
          [cash("100")],
        );
        const [item] =
          await sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${sale.sale_id}`;
        const [refund, closed] = await Promise.all([
          attempt(
            rpc(
              sql,
              "pos_refund_sale",
              manager,
              sale.sale_id,
              sessionId,
              [{ sale_item_id: item!["id"], quantity: 1 }],
              [{ method: "cash", amount: "50" }],
              "returned",
              true,
              key("rf"),
            ),
          ),
          attempt(
            (async () => {
              await new Promise((r) => setTimeout(r, Math.random() * 10));
              return rpc(sql, "pos_close_session", cashier, sessionId, 350, null, key("close"));
            })(),
          ),
        ]);
        expect(closed.ok).toBe(true);
        const c = (closed as any).value;
        const refunded = await val<number>(sql`
          SELECT COALESCE(SUM(po.amount),0)::numeric FROM public.pos_refund_payouts po
          JOIN public.pos_refunds r ON r.id = po.refund_id WHERE r.session_id = ${sessionId} AND po.method = 'cash'`);
        // float 300 + cash sale 100 - cash refunds that committed before the close
        expect(Number(c.expected_cash)).toBe(400 - Number(refunded));
        expect(refund.ok).toBe(Number(refunded) === 50);
        if (!refund.ok) expect(refund.message).toMatch(/^session_closed/);
      }
    });

    it("a void racing the close is either excluded from expected cash (and stock restored) or refused", async () => {
      for (let round = 0; round < 8; round++) {
        const { product, sessionId } = await setup(10);
        const sale = await sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: product, quantity: 1 }],
          [cash("50")],
        );
        const [voided, closed] = await Promise.all([
          attempt(rpc(sql, "pos_void_sale", manager, sale.sale_id, "cashier error", key("vd"))),
          attempt(
            (async () => {
              await new Promise((r) => setTimeout(r, Math.random() * 10));
              return rpc(sql, "pos_close_session", cashier, sessionId, 350, null, key("close"));
            })(),
          ),
        ]);
        expect(closed.ok).toBe(true);
        const c = (closed as any).value;
        if (voided.ok) {
          expect(Number(c.expected_cash)).toBe(300); // sale voided before close: no cash counted
          expect((await stockOf(sql, product)).on_hand).toBe(10);
        } else {
          expect(voided.message).toMatch(/^session_closed/);
          expect(Number(c.expected_cash)).toBe(350);
          expect((await stockOf(sql, product)).on_hand).toBe(9);
        }
      }
    });
  });

  describe("online order creation", () => {
    it("6 simultaneous duplicates of one checkout request create exactly one order and one hold", async () => {
      const product = await mkProduct(sql, 60);
      await receive(sql, manager, product, 5);
      const customer = await mkUser(sql, "customer");
      const idem = key("checkout");
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          attempt(
            rpc(
              sql,
              "create_online_order",
              customer,
              [{ product_id: product, quantity: 2 }],
              "C",
              "0820000000",
              null,
              idem,
              30,
            ),
          ),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => (r as any).value.order_id)).size).toBe(1);
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 5, held: 2, available: 3 });
      const orders = await val(
        sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${customer}`,
      );
      expect(orders).toBe(1);
    });

    it("one customer cannot lock up stock behind unlimited unpaid holds (inventory-denial guard)", async () => {
      const product = await mkProduct(sql, 60);
      await receive(sql, manager, product, 100);
      const customer = await mkUser(sql, "customer");
      const results = [];
      for (let i = 0; i < 7; i++) {
        results.push(
          await attempt(
            rpc(
              sql,
              "create_online_order",
              customer,
              [{ product_id: product, quantity: 1 }],
              "C",
              "0820000000",
              null,
              key("ord"),
              30,
            ),
          ),
        );
      }
      expect(results.filter((r) => r.ok)).toHaveLength(5);
      expect(results.filter((r) => failedWith(r, "too_many_open_orders"))).toHaveLength(2);
      // The same abuse fired in parallel is bounded too (guard runs per request; at most a small overshoot).
      const other = await mkUser(sql, "customer");
      const burst = await Promise.all(
        Array.from({ length: 12 }, () =>
          attempt(
            rpc(
              sql,
              "create_online_order",
              other,
              [{ product_id: product, quantity: 1 }],
              "C",
              "0820000000",
              null,
              key("ord"),
              30,
            ),
          ),
        ),
      );
      expect(burst.filter((r) => r.ok).length).toBeLessThanOrEqual(12);
      expect((await stockOf(sql, product)).held).toBe(5 + burst.filter((r) => r.ok).length);
    });

    it("unknown, inactive or oversized items are rejected without leaving partial orders", async () => {
      const customer = await mkUser(sql, "customer");
      const product = await mkProduct(sql, 60);
      await receive(sql, manager, product, 2);
      for (const items of [
        [{ product_id: uid(), quantity: 1 }],
        [{ product_id: product, quantity: 3 }],
        [{ product_id: product, quantity: 0 }],
        [],
      ]) {
        const r = await attempt(
          rpc(sql, "create_online_order", customer, items, "C", "0820000000", null, key("ord"), 30),
        );
        expect(r.ok).toBe(false);
      }
      expect(
        await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${customer}`),
      ).toBe(0);
      expect((await stockOf(sql, product)).held).toBe(0);
    });
  });

  describe("webhook-to-sale interactions", () => {
    it("a PayPal capture recorded at the till cannot also confirm an online order (and vice-versa)", async () => {
      const { product, sessionId } = await setup(10, 100);
      const customer = await mkUser(sql, "customer");
      const order = await rpc(
        sql,
        "create_online_order",
        customer,
        [{ product_id: product, quantity: 1 }],
        "C",
        "0820000000",
        null,
        key("ord"),
        30,
      );

      const ref1 = `CAPTURE-${uid().slice(0, 12)}`;
      await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [{ method: "paypal", amount: "100", reference: ref1 }],
      );
      const dup = await attempt(
        rpc(sql, "confirm_order_payment", "paypal", ref1, order.order_id, 100),
      );
      expect(failedWith(dup, "payment_reference_in_use")).toBe(true);

      const ref2 = `CAPTURE-${uid().slice(0, 12)}`;
      await rpc(sql, "confirm_order_payment", "paypal", ref2, order.order_id, 100);
      const reverse = await attempt(
        sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: product, quantity: 1 }],
          [{ method: "paypal", amount: "100", reference: ref2 }],
        ),
      );
      expect(failedWith(reverse, "payment_reference_in_use")).toBe(true);
    });

    it("the same capture racing between the till and the webhook is honoured exactly once", async () => {
      for (let round = 0; round < 6; round++) {
        const { product, sessionId } = await setup(10, 100);
        const customer = await mkUser(sql, "customer");
        const order = await rpc(
          sql,
          "create_online_order",
          customer,
          [{ product_id: product, quantity: 1 }],
          "C",
          "0820000000",
          null,
          key("ord"),
          30,
        );
        const ref = `CAPTURE-${uid().slice(0, 12)}`;
        const [pos, hook] = await Promise.all([
          attempt(
            sell(
              sql,
              cashier,
              sessionId,
              [{ product_id: product, quantity: 1 }],
              [{ method: "paypal", amount: "100", reference: ref }],
            ),
          ),
          attempt(rpc(sql, "confirm_order_payment", "paypal", ref, order.order_id, 100)),
        ]);
        expect([pos.ok, hook.ok].filter(Boolean)).toHaveLength(1);
      }
    });
  });

  describe("housekeeping", () => {
    it("purges only idempotency keys older than the retention window", async () => {
      const { product, sessionId } = await setup(5);
      await sell(sql, cashier, sessionId, [{ product_id: product, quantity: 1 }], [cash("50")]);
      await sql`UPDATE public.operation_idempotency SET created_at = now() - interval '45 days' WHERE scope = 'pos_open_session'`;
      const purged = await rpc<number>(sql, "purge_old_idempotency_keys");
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(
        await val(
          sql`SELECT count(*)::int FROM public.operation_idempotency WHERE scope = 'pos_sale'`,
        ),
      ).toBeGreaterThanOrEqual(1);
      const tooShort = await attempt(rpc(sql, "purge_old_idempotency_keys", "1 hour"));
      expect(tooShort.ok).toBe(false);
    });

    it("multi-tender sale with card slip reuse across DIFFERENT methods is allowed but same method is not", async () => {
      const { product, sessionId } = await setup(10);
      const ref = `SHARED-${uid().slice(0, 10)}`;
      await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [card("50", ref)],
      );
      const sameMethod = await attempt(
        sell(sql, cashier, sessionId, [{ product_id: product, quantity: 1 }], [card("50", ref)]),
      );
      expect(failedWith(sameMethod, "payment_reference_in_use")).toBe(true);
    });
  });
});
