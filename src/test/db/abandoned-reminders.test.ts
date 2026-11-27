import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkProduct,
  mkUser,
  receive,
  rpc,
  val,
  type Sql,
} from "./helpers";

/** 20261127006000 — reminders for unpaid orders, and the per-member lock on the pay-in-store limit. Real PostgreSQL. */
describe.skipIf(!DB_URL)("abandoned order reminders (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;

  beforeAll(async () => {
    sql = connect(20);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
  });

  async function basket() {
    const product = await mkProduct(sql, 100);
    await receive(sql, manager, product, 20);
    return [{ product_id: product, quantity: 1 }];
  }
  const place = (user: string, items: unknown, pay: string, method = "collection") =>
    rpc(
      sql,
      "checkout_place_order",
      user,
      items,
      "Ada Lovelace",
      "+27 82 000 0000",
      method,
      null,
      pay,
      100,
      null,
      key("co"),
    );
  const run = () => val(sql`SELECT public.abandoned_order_reminders_enqueue()`);
  const queued = (orderId: string) =>
    sql`SELECT template, recipient, category, data FROM public.notification_events
        WHERE dedupe_key LIKE ${"abandon:" + orderId + ":%"}`;
  const age = (orderId: string, minutes: number) =>
    sql`UPDATE public.orders SET created_at = now() - make_interval(mins => ${minutes}) WHERE id = ${orderId}`;
  /** Moves a hold's expiry (the guard that makes reservations append-only is bypassed for this fixture only). */
  const holdEndsIn = (orderId: string, minutes: number) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE public.stock_reservations SET expires_at = now() + make_interval(mins => ${minutes})
               WHERE order_id = ${orderId} AND status = 'held'`;
    });

  it("reminds an online order once it has waited 30 minutes, and only once", async () => {
    const m = await mkMember(sql);
    const o = await place(m, await basket(), "card");
    await run();
    expect(await queued(o.order_id)).toHaveLength(0); // just placed
    await age(o.order_id, 40);
    await run();
    const rows = await queued(o.order_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template: "order_abandoned", category: "transactional" });
    expect((rows[0]!["data"] as any).kind).toBe("pay");
    await run();
    expect(await queued(o.order_id)).toHaveLength(1);
  });

  it("reminds a pay-in-store order only when its 24-hour hold is nearly over", async () => {
    const m = await mkMember(sql);
    const o = await place(m, await basket(), "cash");
    await age(o.order_id, 40);
    await run();
    expect(await queued(o.order_id)).toHaveLength(0); // 24 hours left: too early
    await holdEndsIn(o.order_id, 300);
    await run();
    const rows = await queued(o.order_id);
    expect(rows).toHaveLength(1);
    expect((rows[0]!["data"] as any).kind).toBe("collect");
  });

  it("does not remind when the hold has lapsed, the order is paid, cancelled, or a payment is under review", async () => {
    const m = await mkMember(sql);
    const lapsed = await place(m, await basket(), "card");
    await age(lapsed.order_id, 40);
    await holdEndsIn(lapsed.order_id, 5); // under 15 minutes left: not worth a nudge
    const cancelled = await place(m, await basket(), "card");
    await age(cancelled.order_id, 40);
    await sql`UPDATE public.orders SET status = 'cancelled' WHERE id = ${cancelled.order_id}`.catch(
      () => {},
    );
    const review = await place(m, await basket(), "card");
    await age(review.order_id, 40);
    await sql`INSERT INTO public.payment_transactions
                (order_id, user_id, provider, mode, status, order_total_rand, expected_amount, expected_currency)
              VALUES (${review.order_id}, ${m}, 'eft', 'live', 'pending_approval', 100, 100, 'ZAR')`;
    await run();
    for (const id of [lapsed.order_id, cancelled.order_id, review.order_id]) {
      expect(await queued(id)).toHaveLength(0);
    }
  });

  it("skips staff purchases and deactivated accounts", async () => {
    const m = await mkMember(sql);
    const o = await place(m, await basket(), "card");
    await age(o.order_id, 40);
    await sql`UPDATE public.profiles SET deactivated_at = now() WHERE id = ${m}`;
    await run();
    expect(await queued(o.order_id)).toHaveLength(0);
  });

  it("the reminder function is service-role only", async () => {
    expect(
      await val(
        sql`SELECT has_function_privilege('authenticated', 'public.abandoned_order_reminders_enqueue()', 'EXECUTE')`,
      ),
    ).toBe(false);
    expect(
      await val(
        sql`SELECT has_function_privilege('service_role', 'public.abandoned_order_reminders_enqueue()', 'EXECUTE')`,
      ),
    ).toBe(true);
  });

  it("simultaneous pay-in-store orders from one member cannot beat the two-order limit", async () => {
    const m = await mkMember(sql);
    const items = await basket();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => attempt(place(m, items, "cash"))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => failedWith(r, "pay_in_store_limit"))).toHaveLength(4);
    expect(
      await val(
        sql`SELECT position('-- pis_lock' IN pg_get_functiondef('public.checkout_place_order(uuid,jsonb,text,text,text,uuid,text,numeric,text,text)'::regprocedure)) > 0`,
      ),
    ).toBe(true);
  });
});
