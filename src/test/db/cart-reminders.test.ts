import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  attempt,
  connect,
  failedWith,
  key,
  loyaltyOf,
  mkMember,
  mkProduct,
  mkUser,
  payOrder,
  receive,
  rpc,
  val,
  type Sql,
} from "./helpers";

/** 20261127007000 — saved baskets, cart reminder emails and the double-points incentive. Real PostgreSQL. */
describe.skipIf(!DB_URL)("cart reminders (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  const NOON = "2026-11-10T10:00:00Z"; // 12:00 in South Africa
  const NIGHT = "2026-11-10T22:30:00Z"; // 00:30 in South Africa

  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => {
    await sql.end();
  });
  afterEach(async () => {
    await assertInventoryConsistent(sql);
  });

  const product = (price = 100) => mkProduct(sql, price);
  const save = (u: string, items: { product_id: string; quantity: number }[]) =>
    rpc(sql, "cart_save", u, items);
  const run = (at = NOON) =>
    val<number>(sql`SELECT public.cart_reminders_enqueue(${at}::timestamptz)`);
  const idle = (u: string, hours: number) =>
    sql`UPDATE public.member_carts SET updated_at = now() - make_interval(hours => ${hours}) WHERE user_id = ${u}`;
  const sent = (u: string) =>
    sql`SELECT data, category, dedupe_key FROM public.notification_events
        WHERE template = 'cart_reminder' AND recipient_user_id = ${u} ORDER BY created_at`;

  it("saves one line per product, clamps quantities and refuses bad input", async () => {
    const u = await mkMember(sql);
    const p = await product();
    await save(u, [
      { product_id: p, quantity: 2 },
      { product_id: p, quantity: 3 },
    ]);
    expect(await rpc(sql, "cart_get", u)).toEqual([{ product_id: p, quantity: 5 }]);
    await save(u, [{ product_id: p, quantity: 5000 }]);
    expect(((await rpc(sql, "cart_get", u)) as { quantity: number }[])[0]!.quantity).toBe(999);
    expect(
      failedWith(await attempt(rpc(sql, "cart_save", u, { not: "a list" })), "cart_invalid"),
    ).toBe(true);
    expect((await attempt(save(u, [{ product_id: "nope", quantity: 1 }]))).ok).toBe(false);
    expect(
      (
        await attempt(
          rpc(
            sql,
            "cart_save",
            u,
            Array.from({ length: 51 }, () => ({ product_id: p, quantity: 1 })),
          ),
        )
      ).ok,
    ).toBe(false);
  });

  it("emails a basket idle for 2 hours, once, then the incentive email a day later", async () => {
    const u = await mkMember(sql);
    const p = await product(120);
    await save(u, [{ product_id: p, quantity: 2 }]);
    await run();
    expect(await sent(u)).toHaveLength(0); // just saved
    await idle(u, 3);
    await run();
    let rows = await sent(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "marketing" });
    expect(rows[0]!["data"]).toMatchObject({
      stage: 1,
      subtotal_rand: 240,
      unsubscribe_kind: "cart",
    });
    await run();
    expect(await sent(u)).toHaveLength(1); // never twice
    await sql`UPDATE public.member_carts SET reminder_1_at = now() - interval '25 hours', updated_at = now() - interval '26 hours'
              WHERE user_id = ${u}`;
    await run();
    rows = await sent(u);
    expect(rows).toHaveLength(2);
    expect((rows[1]!["data"] as { stage: number }).stage).toBe(2);
    await sql`UPDATE public.member_carts SET reminder_2_at = now() - interval '2 days' WHERE user_id = ${u}`;
    await run();
    expect(await sent(u)).toHaveLength(2); // never a third for this basket
  });

  it("sends nothing overnight", async () => {
    const u = await mkMember(sql);
    await save(u, [{ product_id: await product(), quantity: 1 }]);
    await idle(u, 5);
    expect(await run(NIGHT)).toBe(0);
    expect(await sent(u)).toHaveLength(0);
    await run();
    expect(await sent(u)).toHaveLength(1);
  });

  it("skips unsubscribed, staff, deactivated members and anyone who ordered since", async () => {
    const p = await product();
    const items = [{ product_id: p, quantity: 1 }];
    const unsub = await mkMember(sql);
    const staff = await mkUser(sql, "budtender");
    const gone = await mkMember(sql);
    const bought = await mkMember(sql);
    for (const u of [unsub, staff, gone, bought]) {
      await save(u, items);
      await idle(u, 5);
    }
    const token = await val<string>(
      sql`SELECT unsubscribe_token FROM public.member_carts WHERE user_id = ${unsub}`,
    );
    await rpc(sql, "cart_unsubscribe", token);
    await sql`UPDATE public.profiles SET deactivated_at = now() WHERE id = ${gone}`;
    await sql`INSERT INTO public.orders (user_id, total_rand) VALUES (${bought}, 100)`;
    await run();
    for (const u of [unsub, staff, gone, bought]) expect(await sent(u)).toHaveLength(0);
  });

  it("a new basket within 3 days of the last cart email does not start a new cycle", async () => {
    const u = await mkMember(sql);
    const p = await product();
    await save(u, [{ product_id: p, quantity: 1 }]);
    await idle(u, 3);
    await run();
    expect(await sent(u)).toHaveLength(1);
    await save(u, []); // emptied (or bought)
    await save(u, [{ product_id: p, quantity: 2 }]);
    await idle(u, 3);
    await run();
    expect(await sent(u)).toHaveLength(1);
    await sql`UPDATE public.member_carts SET reminder_1_at = now() - interval '4 days' WHERE user_id = ${u}`;
    // The first email is "4 days old" now: move its dedupe key so the test's second cycle cannot land in the same second.
    await sql`UPDATE public.notification_events SET dedupe_key = dedupe_key || ':aged'
              WHERE template = 'cart_reminder' AND recipient_user_id = ${u}`;
    await save(u, []);
    await save(u, [{ product_id: p, quantity: 1 }]);
    await idle(u, 3);
    await run();
    expect(await sent(u)).toHaveLength(2); // 3+ days later: a fresh cycle
  });

  it("leaves out products that are no longer on sale, and skips the email if nothing is left", async () => {
    const u = await mkMember(sql);
    const live = await product(80);
    const dead = await product(90);
    await save(u, [
      { product_id: live, quantity: 1 },
      { product_id: dead, quantity: 1 },
    ]);
    await sql`UPDATE public.products SET is_active = false WHERE id = ${dead}`;
    await idle(u, 3);
    await run();
    const rows = await sent(u);
    expect((rows[0]!["data"] as { items: unknown[] }).items).toHaveLength(1);
    const v = await mkMember(sql);
    await save(v, [{ product_id: dead, quantity: 1 }]);
    await idle(v, 3);
    await run();
    expect(await sent(v)).toHaveLength(0);
  });

  it("unsubscribe fails for an unknown link and still succeeds when used twice", async () => {
    const u = await mkMember(sql);
    await save(u, [{ product_id: await product(), quantity: 1 }]);
    const token = await val<string>(
      sql`SELECT unsubscribe_token FROM public.member_carts WHERE user_id = ${u}`,
    );
    expect(await rpc(sql, "cart_unsubscribe", token)).toMatchObject({ status: "unsubscribed" });
    expect(await rpc(sql, "cart_unsubscribe", token)).toMatchObject({ status: "unsubscribed" });
    expect(
      failedWith(await attempt(rpc(sql, "cart_unsubscribe", "a".repeat(48))), "invalid_token"),
    ).toBe(true);
  });

  it("two first saves at the same moment keep the later one", async () => {
    const u = await mkMember(sql);
    const a = await product();
    const b = await product();
    await Promise.all([
      save(u, [{ product_id: a, quantity: 1 }]),
      save(u, [{ product_id: b, quantity: 2 }]),
    ]);
    const items = (await rpc(sql, "cart_get", u)) as { product_id: string }[];
    expect(items).toHaveLength(1);
    expect([a, b]).toContain(items[0]!.product_id);
  });

  it("admin_cart_recovery is staff only and counts reminders and orders placed after one", async () => {
    const stats = async () =>
      (await rpc(sql, "admin_cart_recovery", manager, 30)) as Record<string, number>;
    const before = await stats();
    const u = await mkMember(sql);
    expect((await attempt(rpc(sql, "admin_cart_recovery", u, 30))).ok).toBe(false);
    await save(u, [{ product_id: await product(), quantity: 1 }]);
    await sql`UPDATE public.member_carts SET reminder_1_at = now() - interval '1 day' WHERE user_id = ${u}`;
    const p = await product(500);
    await receive(sql, manager, p, 5);
    const o = await rpc(
      sql,
      "create_online_order",
      u,
      [{ product_id: p, quantity: 1 }],
      "Ada",
      "0820000000",
      null,
      key("ord"),
      30,
    );
    await payOrder(sql, o.order_id);
    const total = Number(
      await val(sql`SELECT total_rand FROM public.orders WHERE id = ${o.order_id}`),
    );
    const after = await stats();
    expect(after.baskets_saved! - before.baskets_saved!).toBe(1);
    expect(after.first_emails! - before.first_emails!).toBe(1);
    expect(after.second_emails! - before.second_emails!).toBe(0);
    expect(after.recovered_orders! - before.recovered_orders!).toBe(1);
    expect(Number(after.recovered_rand) - Number(before.recovered_rand)).toBeCloseTo(total, 2);
  });

  it("cart emails are low priority and unpaid-order reminders are normal; the functions are service-role only", async () => {
    expect(await val(sql`SELECT public._email_tier('cart_reminder')`)).toBe(3);
    expect(await val(sql`SELECT public._email_tier('order_abandoned')`)).toBe(2);
    expect(await val(sql`SELECT public._email_tier('order_confirmed')`)).toBe(1);
    for (const f of [
      "cart_save(uuid, jsonb)",
      "cart_get(uuid)",
      "cart_unsubscribe(text)",
      "cart_reminders_enqueue(timestamptz)",
    ]) {
      expect(
        await val(sql`SELECT has_function_privilege('authenticated', ${"public." + f}, 'EXECUTE')`),
      ).toBe(false);
    }
    expect(
      await val(sql`SELECT has_table_privilege('authenticated', 'public.member_carts', 'SELECT')`),
    ).toBe(false);
  });

  describe("double points on the order that follows the second email", () => {
    const collect = (u: string, p: string) =>
      rpc(
        sql,
        "checkout_place_order",
        u,
        [{ product_id: p, quantity: 1 }],
        "Ada",
        "+27 82 000 0000",
        "collection",
        null,
        "card",
        500,
        null,
        key("co"),
      );
    /** Places a R500 collection order, backdates it outside the Black Friday window, completes it, returns the points earned. */
    async function earned(u: string, createdAt: string) {
      const p = await product(500);
      await receive(sql, manager, p, 5);
      const o = await collect(u, p);
      await sql`UPDATE public.orders SET created_at = ${createdAt}::timestamptz WHERE id = ${o.order_id}`;
      await payOrder(sql, o.order_id);
      for (const s of ["packing", "ready", "completed"]) {
        await rpc(sql, "transition_order_status", o.order_id, s, manager, null);
      }
      return (await loyaltyOf(sql, u))!.points_balance as number;
    }

    it("doubles the points inside the 48-hour window and not outside it", async () => {
      const plain = await mkMember(sql);
      expect(await earned(plain, "2026-10-03T10:00:00Z")).toBe(10);

      const within = await mkMember(sql);
      await save(within, [{ product_id: await product(), quantity: 1 }]);
      await sql`UPDATE public.member_carts SET reminder_2_at = '2026-10-02T10:00:00Z' WHERE user_id = ${within}`;
      expect(await earned(within, "2026-10-03T10:00:00Z")).toBe(20);

      const late = await mkMember(sql);
      await save(late, [{ product_id: await product(), quantity: 1 }]);
      await sql`UPDATE public.member_carts SET reminder_2_at = '2026-09-25T10:00:00Z' WHERE user_id = ${late}`;
      expect(await earned(late, "2026-10-03T10:00:00Z")).toBe(10);

      const first = await mkMember(sql);
      await save(first, [{ product_id: await product(), quantity: 1 }]);
      await sql`UPDATE public.member_carts SET reminder_1_at = '2026-10-02T10:00:00Z' WHERE user_id = ${first}`;
      expect(await earned(first, "2026-10-03T10:00:00Z")).toBe(10); // only the second email carries the offer
    });

    it("never doubles points on an order that is not for collection", async () => {
      const u = await mkMember(sql);
      await save(u, [{ product_id: await product(), quantity: 1 }]);
      await sql`UPDATE public.member_carts SET reminder_2_at = '2026-10-02T10:00:00Z' WHERE user_id = ${u}`;
      const p = await product(500);
      await receive(sql, manager, p, 5);
      const o = await rpc(
        sql,
        "create_online_order",
        u,
        [{ product_id: p, quantity: 1 }],
        "Ada",
        "0820000000",
        null,
        key("ord"),
        30,
      );
      await sql`UPDATE public.orders SET created_at = '2026-10-03T10:00:00Z'::timestamptz WHERE id = ${o.order_id}`;
      expect(
        await val(
          sql`SELECT delivery_method IS DISTINCT FROM 'collection' FROM public.orders WHERE id = ${o.order_id}`,
        ),
      ).toBe(true);
      await payOrder(sql, o.order_id);
      for (const s of ["packing", "ready", "out_for_delivery", "completed"]) {
        await rpc(sql, "transition_order_status", o.order_id, s, manager, null);
      }
      expect((await loyaltyOf(sql, u))!.points_balance).toBe(10);
    });
  });
});
