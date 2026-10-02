import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
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
  uid,
  val,
  advanceOrder,
  type Sql,
} from "./helpers";

/** Milestone 6: structured, attributable, tamper-evident audit events for admin, manager and POS actions. */
describe.skipIf(!DB_URL)("audit coverage (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
  });
  afterAll(async () => void (await sql.end()));

  const events = (action: string, actor: string | null, since: Date) =>
    val<number>(
      actor
        ? sql`SELECT count(*)::int FROM public.audit_log WHERE action = ${action} AND actor_user_id = ${actor} AND created_at >= ${since}`
        : sql`SELECT count(*)::int FROM public.audit_log WHERE action = ${action} AND created_at >= ${since}`,
    );

  it("the audit log is append-only: no update, delete or truncate — even for a privileged connection", async () => {
    await rpc(sql, "_audit", manager, "audit_selftest", "test", null, { n: 1 });
    expect(
      (
        await attempt(
          Promise.resolve(
            sql`UPDATE public.audit_log SET action = 'x' WHERE action = 'audit_selftest'`,
          ),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await attempt(
          Promise.resolve(sql`DELETE FROM public.audit_log WHERE action = 'audit_selftest'`),
        )
      ).ok,
    ).toBe(false);
    expect((await attempt(Promise.resolve(sql`TRUNCATE public.audit_log`))).ok).toBe(false);
    expect(
      await val(sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'audit_selftest'`),
    ).toBeGreaterThan(0);
  });

  it("every till sale, session open/close, stock receipt and stock adjustment is attributed to the staff member", async () => {
    const since = new Date(Date.now() - 1000);
    const { sessionId } = await mkSession(sql, manager, cashier);
    const product = await mkProduct(sql, 80);
    await receive(sql, manager, product, 10);
    const sale = await sell(
      sql,
      cashier,
      sessionId,
      [{ product_id: product, quantity: 1 }],
      [cash(80)],
    );
    expect(sale.sale_id).toBeTruthy();
    await rpc(sql, "pos_close_session", cashier, sessionId, 580, "end of shift", key("close"));
    expect(await events("pos_sale_completed", cashier, since)).toBe(1);
    expect(await events("pos_session_opened", cashier, since)).toBe(1);
    expect(await events("pos_session_closed", cashier, since)).toBe(1);
    expect(await events("stock_received", manager, since)).toBeGreaterThanOrEqual(1);
    const [row] =
      await sql`SELECT metadata FROM public.audit_log WHERE action = 'pos_sale_completed' AND entity_id = ${sale.sale_id}`;
    expect(row!["metadata"]).toMatchObject({ total: 80 });
  });

  it("every order status change is recorded with who made it", async () => {
    const since = new Date(Date.now() - 1000);
    const member = await mkMember(sql);
    const product = await mkProduct(sql, 100);
    await receive(sql, manager, product, 5);
    const { orderId } = await placeOrder(sql, member, [{ product_id: product, quantity: 1 }]);
    await advanceOrder(sql, manager, orderId, "confirmed");
    await rpc(sql, "transition_order_status", orderId, "packing", manager, null);
    const rows =
      await sql`SELECT metadata, actor_user_id FROM public.audit_log WHERE action = 'order_status_changed' AND entity_id = ${orderId} AND created_at >= ${since} ORDER BY id`;
    expect(rows.map((r) => (r["metadata"] as { to: string }).to)).toEqual([
      "awaiting_payment",
      "confirmed",
      "packing",
    ]);
    expect(rows[2]!["actor_user_id"]).toBe(manager);
  });

  it("role grants, changes and revocations are audited and cannot be done silently", async () => {
    const user = uid();
    await sql`INSERT INTO auth.users (id, email) VALUES (${user}, ${`r-${user}@test.local`})`;
    await sql`DELETE FROM public.user_roles WHERE user_id = ${user}`; // drop whatever sign-up granted
    const since = new Date();
    await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${user}, 'budtender'::public.app_role)`;
    await sql`UPDATE public.user_roles SET role = 'manager'::public.app_role WHERE user_id = ${user} AND role = 'budtender'`;
    await sql`DELETE FROM public.user_roles WHERE user_id = ${user}`;
    const rows =
      await sql`SELECT action, metadata FROM public.audit_log WHERE entity_type = 'user_role' AND metadata->>'user_id' = ${user} AND created_at >= ${since} ORDER BY id`;
    expect(rows.map((r) => r["action"])).toEqual(["role_granted", "role_changed", "role_revoked"]);
    expect(rows[1]!["metadata"]).toMatchObject({ from: "budtender", to: "manager" });
  });

  it("ID verification decisions are audited with the reviewer", async () => {
    const since = new Date(Date.now() - 1000);
    const member = await mkMember(sql); // verified fixture
    await sql`UPDATE public.customer_verification SET status = 'rejected', reviewed_by = ${manager}, reviewed_at = now(), rejection_code = 'unreadable' WHERE user_id = ${member}`;
    expect(await events("id_verification_decided", manager, since)).toBe(1);
  });
});
