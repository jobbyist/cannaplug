import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  cash,
  connect,
  key,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  placeOrder,
  receive,
  rpc,
  sell,
  val,
  type Sql,
} from "./helpers";

// Limits are global settings; these tests use the Concentrates category, which no other suite sells.
const CAT = "Concentrates";

describe.skipIf(!DB_URL)("launch rules (real PostgreSQL)", () => {
  let sql: Sql;
  let admin: string;
  let manager: string;
  let cashier: string;
  let sessionId: string;
  beforeAll(async () => {
    sql = connect(10);
    admin = await mkUser(sql, "admin");
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
    ({ sessionId } = await mkSession(sql, manager, cashier));
  });
  afterAll(async () => {
    await sql`DELETE FROM public.purchase_limits WHERE category = ${CAT}`;
    await sql.end();
  });

  const concentrate = async (stock = 100) => {
    const id = await mkProduct(sql, 100);
    await sql`UPDATE public.products SET category = ${CAT} WHERE id = ${id}`;
    await receive(sql, manager, id, stock);
    return id;
  };
  const setLimit = (max: number, enabled: boolean, actor = admin) =>
    rpc(sql, "purchase_limit_set", actor, CAT, max, enabled, key("lim"));

  describe("purchase limits", () => {
    it("are off until an admin turns one on; then online orders and till sales count together per member and day", async () => {
      const p = await concentrate();
      const member = await mkMember(sql);
      const other = await mkMember(sql);
      // no limit: anything goes
      await setLimit(5, false);
      await placeOrder(sql, member, [{ product_id: p, quantity: 6 }]);

      const fresh = await mkMember(sql);
      await setLimit(5, true);
      await placeOrder(sql, fresh, [{ product_id: p, quantity: 3 }]);
      const over = await attempt(placeOrder(sql, fresh, [{ product_id: p, quantity: 3 }]));
      expect(over.ok).toBe(false);
      if (!over.ok)
        expect(over.message).toMatch(
          /^purchase_limit_exceeded: Concentrates is limited to 5 per day/,
        );
      // the same member at the till: 2 more fits, 3 does not
      await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 2 }], [cash(200)], {
        customer: fresh,
      });
      const till = await attempt(
        sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(100)], {
          customer: fresh,
        }),
      );
      expect(till.ok).toBe(false);
      // a walk-in sale and another member are not affected
      await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 4 }], [cash(400)]);
      await placeOrder(sql, other, [{ product_id: p, quantity: 5 }]);
      // the refused attempts changed nothing
      expect(await val(sql`SELECT count(*)::int FROM public.orders WHERE user_id = ${fresh}`)).toBe(
        1,
      );
    });

    it("a cancelled order no longer counts, and a whole basket is counted at once", async () => {
      const p = await concentrate();
      const m = await mkMember(sql);
      await setLimit(4, true);
      const big = await attempt(placeOrder(sql, m, [{ product_id: p, quantity: 5 }]));
      expect(big.ok).toBe(false);
      const first = await placeOrder(sql, m, [{ product_id: p, quantity: 4 }]);
      await rpc(sql, "transition_order_status", first.orderId, "cancelled", manager, "test");
      await placeOrder(sql, m, [{ product_id: p, quantity: 4 }]);
    });

    it("only admins set limits; values are checked; changes are audited; browsers cannot touch them", async () => {
      for (const actor of [manager, cashier]) {
        const r = await attempt(setLimit(3, true, actor));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(/^forbidden/);
      }
      expect(
        (await attempt(rpc(sql, "purchase_limit_set", admin, "Weed", 3, true, key("l")))).ok,
      ).toBe(false);
      expect(
        (await attempt(rpc(sql, "purchase_limit_set", admin, CAT, 0, true, key("l")))).ok,
      ).toBe(false);
      await setLimit(7, true);
      const meta =
        await val(sql`SELECT metadata FROM public.audit_log WHERE action = 'purchase_limit_set'
                                 AND actor_user_id = ${admin} ORDER BY id DESC LIMIT 1`);
      expect(meta).toMatchObject({ category: CAT, daily_max: 7, enabled: true });
      const browser = await attempt(
        asUser(sql, admin, (tx) => tx`SELECT * FROM public.purchase_limits`),
      );
      expect(browser.ok).toBe(false);
      const rpcBrowser = await attempt(
        asUser(
          sql,
          admin,
          (tx) =>
            tx`SELECT public.purchase_limit_set(${admin}::uuid, ${CAT}, 9, true, ${key("l")})`,
        ),
      );
      expect(rpcBrowser.ok).toBe(false);
      await setLimit(7, false);
    });
  });

  describe("ID lockout reset", () => {
    const locked = async () => {
      const m = await mkUser(sql, "customer");
      await sql`INSERT INTO public.customer_verification (user_id, status, attempt_count)
                VALUES (${m}, 'rejected', 5) ON CONFLICT (user_id) DO UPDATE SET status = 'rejected', attempt_count = 5`;
      return m;
    };
    const reset = (
      actor: string,
      member: string,
      reason = "Spoke to the member in store; photo was blurry",
    ) => rpc(sql, "verification_reset_attempts", actor, member, reason, key("reset"));

    it("an admin unlocks a locked-out member with a reason, and it is audited", async () => {
      const m = await locked();
      expect(await reset(admin, m)).toMatchObject({ attempt_count: 0 });
      expect(
        await val(sql`SELECT attempt_count FROM public.customer_verification WHERE user_id = ${m}`),
      ).toBe(0);
      const a = await sql`SELECT actor_user_id, metadata FROM public.audit_log
                          WHERE action = 'id_attempts_reset' AND entity_id = ${m}`;
      expect(a).toHaveLength(1);
      expect(a[0]!["metadata"]).toMatchObject({ previous_attempts: 5 });
    });

    it("needs an admin, a real reason, another person, and a member who is actually locked out", async () => {
      const m = await locked();
      for (const actor of [manager, cashier])
        expect((await attempt(reset(actor, m))).ok, actor).toBe(false);
      const short = await attempt(reset(admin, m, "ok"));
      expect(short.ok).toBe(false);
      if (!short.ok) expect(short.message).toMatch(/^reason_required/);
      await sql`INSERT INTO public.customer_verification (user_id, status, attempt_count) VALUES (${admin}, 'rejected', 5)
                ON CONFLICT (user_id) DO UPDATE SET status = 'rejected', attempt_count = 5`;
      const self = await attempt(reset(admin, admin));
      expect(self.ok).toBe(false);
      const fine = await mkUser(sql, "customer");
      await sql`INSERT INTO public.customer_verification (user_id, status, attempt_count) VALUES (${fine}, 'rejected', 2)
                ON CONFLICT (user_id) DO UPDATE SET status = 'rejected', attempt_count = 2`;
      const notLocked = await attempt(reset(admin, fine));
      expect(notLocked.ok).toBe(false);
      if (!notLocked.ok) expect(notLocked.message).toMatch(/^not_locked/);
      expect(
        await val(sql`SELECT attempt_count FROM public.customer_verification WHERE user_id = ${m}`),
      ).toBe(5);
    });
  });

  it("the daily low-stock email uses each product's threshold (checked in a rolled-back transaction)", async () => {
    const high = await mkProduct(sql, 10);
    const low = await mkProduct(sql, 10);
    await receive(sql, manager, high, 20);
    await receive(sql, manager, low, 20);
    await sql`UPDATE public.products SET low_stock_threshold = 50 WHERE id = ${high}`;
    await sql`UPDATE public.products SET low_stock_threshold = 0 WHERE id = ${low}`;
    expect(
      (await attempt(sql`UPDATE public.products SET low_stock_threshold = -1 WHERE id = ${low}`))
        .ok,
    ).toBe(false);
    const names = await sql`SELECT id, name FROM public.products WHERE id IN (${high}, ${low})`;
    const nameOf = (id: string) => names.find((n) => n["id"] === id)!["name"];
    await sql
      .begin(async (tx) => {
        await tx`DELETE FROM public.notification_events WHERE dedupe_key LIKE 'lowstock:%'`;
        await tx`SELECT public.email_automations_run()`;
        const rows =
          await tx`SELECT data FROM public.notification_events WHERE template = 'staff_low_stock'`;
        const items = rows.flatMap((r) =>
          (r["data"] as { items: { name: string }[] }).items.map((i) => i.name),
        );
        expect(items).toContain(nameOf(high));
        expect(items).not.toContain(nameOf(low));
        throw new Error("rollback");
      })
      .catch((e) => expect((e as Error).message).toBe("rollback"));
  });
});
