import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  attempt,
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

/** Tests added while triaging the Amazon Q Milestone 3 concurrency review (PR #15). */
describe.skipIf(!DB_URL)("Amazon Q review triage (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;

  beforeAll(async () => {
    sql = connect(40);
    await Promise.all(Array.from({ length: 40 }, () => sql`SELECT pg_sleep(0.2)`));
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
  });

  const setup = async (qty = 20, price = 100) => {
    const product = await mkProduct(sql, price);
    await receive(sql, manager, product, qty);
    const { sessionId } = await mkSession(sql, manager, cashier);
    return { product, sessionId };
  };
  const item = async (saleId: string) =>
    val<string>(sql`SELECT id FROM public.pos_sale_items WHERE sale_id = ${saleId}`);

  describe("'consumed' is NET of returns (finding #2 was incorrect: restocks must REDUCE consumed)", () => {
    it("a void returns consumed to zero; a restocking refund reduces it; a non-restocking refund does not", async () => {
      const { product, sessionId } = await setup();
      const sale = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 2 }],
        [cash("200")],
      );
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 18, consumed: 2 });
      await rpc(sql, "pos_void_sale", manager, sale.sale_id, "test void", key("vd"));
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 20, consumed: 0 });

      const s2 = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 3 }],
        [cash("300")],
      );
      const line = await item(s2.sale_id);
      await rpc(
        sql,
        "pos_refund_sale",
        manager,
        s2.sale_id,
        sessionId,
        [{ sale_item_id: line, quantity: 1 }],
        [{ method: "cash", amount: "100" }],
        "restocked return",
        true,
        key("rf"),
      );
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 18, consumed: 2 });
      await rpc(
        sql,
        "pos_refund_sale",
        manager,
        s2.sale_id,
        sessionId,
        [{ sale_item_id: line, quantity: 1 }],
        [{ method: "cash", amount: "100" }],
        "goods not returned",
        false,
        key("rf"),
      );
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 18, consumed: 2 }); // stock never came back
    });

    it("an online order: held, then consumed on payment, then back to zero on cancellation", async () => {
      const product = await mkProduct(sql, 100);
      await receive(sql, manager, product, 5);
      const customer = await mkUser(sql, "customer");
      const order = await rpc(
        sql,
        "create_online_order",
        customer,
        [{ product_id: product, quantity: 2 }],
        "C",
        "0820000000",
        null,
        key("ord"),
        30,
      );
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 5, held: 2, consumed: 0 });
      await rpc(
        sql,
        "confirm_order_payment",
        "paypal",
        `EV-${uid().slice(0, 12)}`,
        order.order_id,
        200,
      );
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 3, held: 0, consumed: 2 });
      await rpc(
        sql,
        "transition_order_status",
        order.order_id,
        "cancelled",
        manager,
        "cancel after payment",
      );
      expect(await stockOf(sql, product)).toMatchObject({ on_hand: 5, held: 0, consumed: 0 });
    });
  });

  describe("payment event input is validated before any lock is taken (finding #3)", () => {
    it.each([
      ["unknown provider", "bitcoin", `EV-${"x".repeat(8)}`, 100],
      ["event id too short", "paypal", "abc", 100],
      ["event id too long", "paypal", "e".repeat(201), 100],
      ["null amount", "paypal", `EV-${"y".repeat(8)}`, null],
      ["zero amount", "paypal", `EV-${"z".repeat(8)}`, 0],
      ["3-decimal amount", "paypal", `EV-${"w".repeat(8)}`, 100.005],
    ])("rejects %s", async (_label, provider, eventId, amount) => {
      // scoped to this event: other test files record payments concurrently in the same database
      const r = await attempt(rpc(sql, "confirm_order_payment", provider, eventId, uid(), amount));
      expect(failedWith(r, "invalid_payment_event")).toBe(true);
      expect(
        await val<number>(sql`SELECT count(*)::int FROM public.payment_events WHERE provider = ${provider} AND provider_event_id = ${eventId}`),
      ).toBe(0);
    });
  });

  describe("maintenance functions enforce READ COMMITTED like every other mutator (finding #1)", () => {
    it.each([
      "release_expired_reservations",
      "purge_old_idempotency_keys",
      "accrue_missing_pos_loyalty",
    ])("%s refuses REPEATABLE READ", async (fn) => {
      const r = await attempt(
        sql.begin("isolation level repeatable read", async (tx) => {
          await tx`SELECT 1`;
          await tx.unsafe(`SELECT public.${fn}()`);
        }),
      );
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.message).toMatch(/^isolation_level/);
    });
  });

  describe("loyalty retry sweeper (finding #5: 'safe to retry later' needs an actual retry)", () => {
    const backdate = async (saleId: string) => {
      await sql`ALTER TABLE public.pos_sales DISABLE TRIGGER pos_sales_update_guard`;
      await sql`UPDATE public.pos_sales SET created_at = now() - interval '10 minutes' WHERE id = ${saleId}`;
      await sql`ALTER TABLE public.pos_sales ENABLE TRIGGER pos_sales_update_guard`;
    };
    const points = (customer: string) =>
      val<number>(
        sql`SELECT COALESCE(SUM(points),0)::int FROM public.loyalty_ledger WHERE user_id = ${customer}`,
      );

    it("credits a committed sale whose post-commit accrual never happened — exactly once, even when run concurrently", async () => {
      const { product, sessionId } = await setup();
      const customer = await mkUser(sql, "customer");
      const sale = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 3 }],
        [cash("300")],
        { customer },
      );
      // Inside the grace period the sweeper leaves it to the in-flight application call.
      await rpc(sql, "accrue_missing_pos_loyalty");
      expect(await points(customer)).toBe(0);
      await backdate(sale.sale_id);
      const runs = await Promise.all(
        Array.from({ length: 6 }, () => rpc<number>(sql, "accrue_missing_pos_loyalty")),
      );
      expect(runs.reduce((a, b) => a + Number(b), 0)).toBe(1);
      expect(await points(customer)).toBe(30);
      expect(await rpc<number>(sql, "accrue_missing_pos_loyalty")).toBe(0); // nothing left to do
    });

    it("skips voided sales and walk-in sales", async () => {
      const { product, sessionId } = await setup();
      const customer = await mkUser(sql, "customer");
      const voided = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [cash("100")],
        { customer },
      );
      const walkIn = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [cash("100")],
      );
      await rpc(sql, "pos_void_sale", manager, voided.sale_id, "void before accrual", key("vd"));
      await backdate(voided.sale_id);
      await backdate(walkIn.sale_id);
      await rpc(sql, "accrue_missing_pos_loyalty");
      expect(await points(customer)).toBe(0);
    });

    it("racing the normal post-commit accrual never double-credits", async () => {
      for (let round = 0; round < 6; round++) {
        const { product, sessionId } = await setup();
        const customer = await mkUser(sql, "customer");
        const sale = await sell(
          sql,
          cashier,
          sessionId,
          [{ product_id: product, quantity: 1 }],
          [cash("100")],
          { customer },
        );
        await backdate(sale.sale_id);
        await Promise.all([
          rpc(sql, "accrue_pos_loyalty", sale.sale_id),
          rpc(sql, "accrue_missing_pos_loyalty"),
          rpc(sql, "accrue_pos_loyalty", sale.sale_id),
        ]);
        expect(await points(customer)).toBe(10);
      }
    });
  });

  describe("void metadata is audit evidence (finding #6: voided_at was already immutable; voided_by/void_reason were not)", () => {
    it("cannot be rewritten after a void, nor set on a sale that was never voided", async () => {
      const { product, sessionId } = await setup();
      const sale = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [cash("100")],
      );
      const untouched = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: product, quantity: 1 }],
        [cash("100")],
      );
      await rpc(sql, "pos_void_sale", manager, sale.sale_id, "genuine reason", key("vd"));

      for (const stmt of [
        sql`UPDATE public.pos_sales SET void_reason = 'rewritten history' WHERE id = ${sale.sale_id}`,
        sql`UPDATE public.pos_sales SET voided_by = ${cashier} WHERE id = ${sale.sale_id}`,
        sql`UPDATE public.pos_sales SET voided_at = now() + interval '1 day' WHERE id = ${sale.sale_id}`,
        sql`UPDATE public.pos_sales SET void_reason = 'sneaky' WHERE id = ${untouched.sale_id}`,
        sql`UPDATE public.pos_sales SET voided_by = ${manager} WHERE id = ${untouched.sale_id}`,
        sql`UPDATE public.pos_sales SET status = 'completed' WHERE id = ${sale.sale_id}`,
      ]) {
        expect((await attempt(stmt)).ok).toBe(false);
      }
      const [row] =
        await sql`SELECT void_reason, voided_by FROM public.pos_sales WHERE id = ${sale.sale_id}`;
      expect(row).toMatchObject({ void_reason: "genuine reason", voided_by: manager });
    });
  });
});
