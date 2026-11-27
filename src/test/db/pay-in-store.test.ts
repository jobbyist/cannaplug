import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  assertInventoryConsistent,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkProduct,
  mkUser,
  payOrder,
  placeOrder,
  receive,
  rpc,
  stockOf,
  val,
  type Sql,
} from "./helpers";

/** Pay in store (20261127004000) — real PostgreSQL. A collection order reserved online and paid at the till. */
describe.skipIf(!DB_URL)("pay in store (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let budtender: string;

  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    budtender = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
  });

  async function basket(price = 100, qty = 2, stock = 10) {
    const product = await mkProduct(sql, price);
    await receive(sql, manager, product, stock);
    return { product, items: [{ product_id: product, quantity: qty }] };
  }

  const place = (
    user: string,
    items: unknown,
    total: number,
    over: { method?: string; pay?: string; address?: string | null; k?: string } = {},
  ) =>
    rpc(
      sql,
      "checkout_place_order",
      user,
      items,
      "Pay Later",
      "+27 82 000 0000",
      over.method ?? "collection",
      over.address ?? null,
      over.pay ?? "cash",
      total,
      null,
      over.k ?? key("co"),
    );

  const take = (actor: string, order: string, tender = "cash", k = key("pay")) =>
    rpc(sql, "order_take_in_store_payment", actor, order, tender, k);

  it("reserves a collection order for 24 hours without taking stock or payment", async () => {
    const { product, items } = await basket(100, 2, 10);
    const member = await mkMember(sql);
    const o = await place(member, items, 200);
    expect(o).toMatchObject({
      status: "awaiting_payment",
      payment_method: "cash",
      hold_minutes: 1440,
    });
    const row = (
      await sql`SELECT payment_method, status, total_rand FROM public.orders WHERE id = ${o.order_id}`
    )[0]!;
    expect(row["payment_method"]).toBe("cash");
    expect(Number(row["total_rand"])).toBe(200);
    // The stock is held (not consumed) until the member pays in store, and the hold runs a full day.
    const hours = Number(
      await val(
        sql`SELECT extract(epoch FROM (min(expires_at) - now())) / 3600 FROM public.stock_reservations WHERE order_id = ${o.order_id} AND status = 'held'`,
      ),
    );
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    expect(await stockOf(sql, product)).toMatchObject({ on_hand: 10, held: 2 });
  });

  it("keeps online payments on the 2-hour hold", async () => {
    const { items } = await basket();
    const o = await place(await mkMember(sql), items, 200, { pay: "card" });
    expect(o.hold_minutes).toBe(120);
  });

  it("is for collection orders only", async () => {
    const { items } = await basket();
    const member = await mkMember(sql);
    const address = (
      await rpc(
        sql,
        "member_save_address",
        member,
        null,
        {
          label: "Home",
          line1: "12 Long Street",
          city: "Pretoria",
        },
        false,
      )
    ).id as string;
    const out = await attempt(
      place(member, items, 280, { method: "standard", address, pay: "eft" }),
    );
    expect(out.ok).toBe(true); // the control: a delivery order with a normal method is fine
    const refused = await attempt(
      place(member, items, 280, { method: "standard", address, pay: "cash" }),
    );
    expect(failedWith(refused, "pay_in_store_pickup_only")).toBe(true);
  });

  it("allows at most two unpaid pay-in-store orders per member", async () => {
    const member = await mkMember(sql);
    const a = await place(member, (await basket()).items, 200);
    await place(member, (await basket()).items, 200);
    const third = await attempt(place(member, (await basket()).items, 200));
    expect(failedWith(third, "pay_in_store_limit")).toBe(true);
    // Another member is not affected, and a paid order frees a slot.
    expect((await attempt(place(await mkMember(sql), (await basket()).items, 200))).ok).toBe(true);
    await take(budtender, a.order_id);
    expect((await attempt(place(member, (await basket()).items, 200))).ok).toBe(true);
  });

  it("replays the same order for the same idempotency key", async () => {
    const { items } = await basket();
    const member = await mkMember(sql);
    const k = key("same");
    const first = await place(member, items, 200, { k });
    const again = await place(member, items, 200, { k });
    expect(again.order_id).toBe(first.order_id);
    expect(again.replayed).toBe(true);
  });

  it("staff take the payment: the order is confirmed, stock is consumed, the tender is audited", async () => {
    const { product, items } = await basket(100, 2, 10);
    const member = await mkMember(sql);
    const o = await place(member, items, 200);
    const paid = await take(budtender, o.order_id, "card");
    expect(paid).toMatchObject({ outcome: "confirmed", confirmed: true, tender: "card" });
    expect(Number(paid.amount)).toBe(200);
    expect(await val(sql`SELECT status FROM public.orders WHERE id = ${o.order_id}`)).toBe(
      "confirmed",
    );
    expect(await stockOf(sql, product)).toMatchObject({ on_hand: 8, held: 0 });
    const audit = (
      await sql`SELECT actor_user_id, metadata FROM public.audit_log WHERE action = 'order_paid_in_store' AND entity_id = ${o.order_id}`
    )[0];
    expect(audit).toBeTruthy();
    expect(String(JSON.stringify(audit))).toContain("card");
    // Paying twice is refused, and the same key replays safely.
    expect(
      failedWith(await attempt(take(budtender, o.order_id, "cash")), "order_not_awaiting_payment"),
    ).toBe(true);
  });

  it("replays the same payment request without taking stock twice", async () => {
    const { product, items } = await basket(100, 2, 10);
    const o = await place(await mkMember(sql), items, 200);
    const k = key("pay-once");
    await take(budtender, o.order_id, "cash", k);
    const again = await take(budtender, o.order_id, "cash", k);
    expect(again.replayed).toBe(true);
    expect(await stockOf(sql, product)).toMatchObject({ on_hand: 8 });
  });

  it("only takes payment for pay-in-store collection orders", async () => {
    const { items } = await basket();
    const o = await place(await mkMember(sql), items, 200, { pay: "eft" });
    expect(failedWith(await attempt(take(budtender, o.order_id)), "not_pay_in_store")).toBe(true);
    expect(
      failedWith(await attempt(take(budtender, o.order_id, "voucher")), "invalid_tender"),
    ).toBe(true);
  });

  it("reports an expired hold with no stock instead of confirming", async () => {
    const { product, items } = await basket(100, 2, 2);
    const o = await place(await mkMember(sql), items, 200);
    // The 24-hour hold lapses (the guard trigger is paused only to move the clock), and someone else buys the stock.
    await sql`ALTER TABLE public.stock_reservations DISABLE TRIGGER stock_reservations_guard`;
    await sql`UPDATE public.stock_reservations SET expires_at = now() - interval '1 minute' WHERE order_id = ${o.order_id}`;
    await sql`ALTER TABLE public.stock_reservations ENABLE TRIGGER stock_reservations_guard`;
    const other = await placeOrder(sql, await mkMember(sql), items);
    await payOrder(sql, other.orderId);
    const out = await take(budtender, o.order_id);
    expect(out.confirmed).toBe(false);
    expect(out.outcome).toBe("stock_unavailable_needs_refund");
    expect(await val(sql`SELECT status FROM public.orders WHERE id = ${o.order_id}`)).toBe(
      "awaiting_payment",
    );
    expect(await stockOf(sql, product)).toMatchObject({ on_hand: 0 });
  });

  it("caps any hold at 24 hours", async () => {
    const { items } = await basket();
    const r = await rpc(
      sql,
      "create_online_order",
      await mkMember(sql),
      items,
      "Test",
      "0820000000",
      null,
      key("cap"),
      100000,
    );
    expect(r.hold_minutes).toBe(1440);
  });

  it("is staff only: customers and browser roles cannot take a payment", async () => {
    const { items } = await basket();
    const member = await mkMember(sql);
    const o = await place(member, items, 200);
    expect(failedWith(await attempt(take(member, o.order_id)), "staff access required")).toBe(true);
    const viaBrowser = await attempt(
      asUser(sql, budtender, (tx) =>
        rpc(tx, "order_take_in_store_payment", budtender, o.order_id, "cash", key("b")),
      ),
    );
    expect(!viaBrowser.ok && /permission denied/i.test(viaBrowser.message)).toBe(true);
    expect(await val(sql`SELECT status FROM public.orders WHERE id = ${o.order_id}`)).toBe(
      "awaiting_payment",
    );
  });

  /** Runs `fn` against a copy of `signature` rewritten with `from` -> `to`, then rolls everything back. */
  async function withMutation(
    signature: string,
    from: string,
    to: string,
    fn: (tx: Sql) => Promise<void>,
  ) {
    class Undo extends Error {}
    await sql
      .begin(async (tx) => {
        const [def] = await tx`SELECT pg_get_functiondef(${signature}::regprocedure) AS d`;
        const broken = String(def!["d"]).replace(from, to);
        expect(broken).not.toBe(def!["d"]);
        await tx.unsafe(broken);
        await fn(tx as unknown as Sql);
        throw new Undo();
      })
      .catch((e) => {
        if (!(e instanceof Undo)) throw e;
      });
  }

  it("mutation check: without the staff check a customer could mark their own order paid", async () => {
    const { items } = await basket();
    const member = await mkMember(sql);
    const o = await place(member, items, 200);
    await withMutation(
      "public.order_take_in_store_payment(uuid,uuid,text,text)",
      "IF NOT public._is_staff(p_actor) THEN",
      "IF false THEN",
      async (tx) => {
        const r = await attempt(Promise.resolve(take2(tx, member, o.order_id)));
        expect(r.ok).toBe(true); // the mutant lets the customer through
      },
    );
    expect(failedWith(await attempt(take(member, o.order_id)), "staff access required")).toBe(true);
    expect(await val(sql`SELECT status FROM public.orders WHERE id = ${o.order_id}`)).toBe(
      "awaiting_payment",
    );
  });

  it("mutation check: without the pickup-only rule a delivery order could be left unpaid", async () => {
    const { items } = await basket();
    const member = await mkMember(sql);
    const address = (
      await rpc(
        sql,
        "member_save_address",
        member,
        null,
        {
          label: "Home",
          line1: "12 Long Street",
          city: "Pretoria",
        },
        false,
      )
    ).id as string;
    await withMutation(
      "public.checkout_place_order(uuid,jsonb,text,text,text,uuid,text,numeric,text,text)",
      "IF NOT (FOUND AND v_option.is_pickup) THEN",
      "IF false THEN",
      async (tx) => {
        const r = await attempt(
          Promise.resolve(
            tx.unsafe(
              `SELECT public.checkout_place_order('${member}', '${JSON.stringify(items)}'::jsonb, 'Pay Later', '+27 82 000 0000', 'standard', '${address}', 'cash', 280, null, '${key("mut")}')`,
            ),
          ),
        );
        expect(failedWith(r, "pay_in_store_pickup_only")).toBe(false);
      },
    );
    expect(
      failedWith(
        await attempt(place(member, items, 280, { method: "standard", address, pay: "cash" })),
        "pay_in_store_pickup_only",
      ),
    ).toBe(true);
  });

  const take2 = (tx: Sql, actor: string, order: string) =>
    tx.unsafe(
      `SELECT public.order_take_in_store_payment('${actor}', '${order}', 'cash', '${key("mut")}')`,
    );
});
