import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  assertInventoryConsistent,
  assertLoyaltyConsistent,
  attempt,
  connect,
  earnPoints,
  failedWith,
  key,
  loyaltyOf,
  mkMember,
  mkProduct,
  mkSession,
  mkUser,
  receive,
  rpc,
  sell,
  type Role,
  type Sql,
} from "./helpers";

/**
 * The admin Loyalty tab, by staff role: every staff account (budtender, manager, admin) can give a member a
 * points reward and a Plug Back free pre-roll on their own open till. A customer account cannot.
 * These are the same database calls the tab makes (loyalty-desk.server.ts).
 */
describe.skipIf(!DB_URL)("Loyalty tab redemptions for every staff role (real PostgreSQL)", () => {
  let sql: Sql;
  let owner: string; // a manager who sets up drawers and stock
  let greenhouse: string;

  beforeAll(async () => {
    sql = connect(10);
    owner = await mkUser(sql, "manager");
    greenhouse = await mkProduct(sql, 60);
    await sql`UPDATE public.products
              SET name = ${`Role Stick ${greenhouse.slice(0, 5)} (Greenhouse)`}, category = 'Pre-rolls'
              WHERE id = ${greenhouse}`;
    await receive(sql, owner, greenhouse, 50);
  });
  afterAll(async () => {
    await assertInventoryConsistent(sql);
    await assertLoyaltyConsistent(sql);
    await sql.end();
  });

  const staffRoles: Role[] = ["budtender", "manager", "admin"];

  describe.each(staffRoles)("%s", (role) => {
    let staff: string;
    let sessionId: string;

    beforeAll(async () => {
      staff = await mkUser(sql, role);
      ({ sessionId } = await mkSession(sql, owner, staff)); // the staff member's own till
    });

    it("reads the member's points rewards and Plug Back card", async () => {
      const m = await mkMember(sql);
      await earnPoints(sql, owner, m, 5);
      const pts = await rpc(sql, "pos_customer_rewards", staff, m);
      expect(pts.points).toBe(5);
      expect(pts.rewards.map((r: { code: string }) => r.code)).toContain("greenhouse_free");
      const plug = await rpc(sql, "plug_back_summary", staff, m);
      expect(plug).toMatchObject({ tubes: 0, tubes_per_reward: 10 });
    });

    it("redeems 5 points for a free Greenhouse item: R0 sale, points spent", async () => {
      const m = await mkMember(sql);
      await earnPoints(sql, owner, m, 5);
      const s = await sell(
        sql,
        staff,
        sessionId,
        [{ product_id: greenhouse, quantity: 1, reward: "greenhouse_free" }],
        [],
        { customer: m },
      );
      expect(Number(s.total)).toBe(0);
      expect(s.reward_points).toBe(5);
      expect(s.receipt_number).toMatch(/^POS-/);
      expect((await loyaltyOf(sql, m))?.points_balance).toBe(0);
    });

    it("records returned tubes and gives the free Plug Back pre-roll", async () => {
      const m = await mkMember(sql);
      const ret = await rpc(sql, "plug_back_record_return", staff, m, 12, null, key("pb"));
      expect(ret.tubes).toBe(12);
      const r = await rpc(sql, "plug_back_redeem", staff, sessionId, m, greenhouse, key("pbr"));
      expect(r).toMatchObject({ total: 0, tubes_spent: 10, tubes: 2 });
      expect(r.receipt_number).toMatch(/^POS-/);
    });
  });

  it("a customer account is refused every Loyalty tab action and nothing changes", async () => {
    const customer = await mkUser(sql, "customer");
    const m = await mkMember(sql);
    await earnPoints(sql, owner, m, 5);
    await rpc(sql, "plug_back_record_return", owner, m, 10, null, key("pb"));
    const { sessionId } = await mkSession(sql, owner, owner);

    // thunks: each call starts only when awaited, so no rejection goes unhandled
    const tries = [
      () => rpc(sql, "pos_customer_rewards", customer, m),
      () => rpc(sql, "plug_back_summary", customer, m),
      () => rpc(sql, "plug_back_record_return", customer, m, 5, null, key("pb")),
      () => rpc(sql, "plug_back_redeem", customer, sessionId, m, greenhouse, key("pbr")),
      () =>
        sell(
          sql,
          customer,
          sessionId,
          [{ product_id: greenhouse, quantity: 1, reward: "greenhouse_free" }],
          [],
          { customer: m },
        ),
    ];
    for (const t of tries) expect(failedWith(await attempt(t()), "forbidden")).toBe(true);
    expect((await loyaltyOf(sql, m))?.points_balance).toBe(5);
    expect((await rpc(sql, "plug_back_summary", owner, m)).tubes).toBe(10);
  });
});
