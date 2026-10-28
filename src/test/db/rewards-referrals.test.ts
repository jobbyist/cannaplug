import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  assertLoyaltyConsistent,
  attempt,
  cash,
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
  uid,
  val,
  verifyDirect,
  type Sql,
} from "./helpers";

/** Usernames, referrals and loyalty rewards at the till — real PostgreSQL. */
describe.skipIf(!DB_URL)("rewards, referrals and usernames (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let cashier: string;
  let sessionId: string;

  beforeAll(async () => {
    sql = connect(20);
    manager = await mkUser(sql, "manager");
    cashier = await mkUser(sql, "budtender");
    ({ sessionId } = await mkSession(sql, manager, cashier));
  });
  afterAll(async () => {
    await assertLoyaltyConsistent(sql);
    await sql.end();
  });

  const tag = () => `u${uid().replace(/-/g, "").slice(0, 10)}`;
  const setName = (user: string, name: string) =>
    rpc(sql, "member_set_username", user, name, key("un"));
  const signUp = async (meta: Record<string, string>) => {
    const id = uid();
    await sql`INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES (${id}, ${`su-${id.slice(0, 8)}@test.local`}, ${sql.json(meta)})`;
    return id;
  };
  /** A product named like the catalogue ("Name (Grade)") in a category. */
  const graded = async (grade: string, category = "Pre-rolls", price = 50, stock = 50) => {
    const id = await mkProduct(sql, price);
    await sql`UPDATE public.products SET name = ${`Test Stick ${id.slice(0, 5)} (${grade})`}, category = ${category} WHERE id = ${id}`;
    await receive(sql, manager, id, stock);
    return id;
  };
  const referralOf = async (referee: string) =>
    (
      await sql`SELECT referrer_id, status FROM public.referrals WHERE referee_id = ${referee}`
    )[0] ?? null;

  describe("usernames", () => {
    it("checks the format, reserved words and uniqueness", async () => {
      expect(await rpc(sql, "username_check", "ab")).toBe("invalid");
      expect(await rpc(sql, "username_check", "has space")).toBe("invalid");
      expect(await rpc(sql, "username_check", "x".repeat(21))).toBe("invalid");
      expect(await rpc(sql, "username_check", "Admin")).toBe("reserved");
      expect(await rpc(sql, "username_check", "cannaplug")).toBe("reserved");
      const u = await mkUser(sql, "customer");
      const name = tag();
      await setName(u, name);
      expect(await rpc(sql, "username_check", name.toUpperCase())).toBe("taken");
      expect(await rpc(sql, "username_check", tag())).toBe("ok");
    });

    it("a member sets it once (lower-cased, audited, replay-safe), and it is unique", async () => {
      const u = await mkUser(sql, "customer");
      const name = tag();
      const k = key("un");
      const first = await rpc(sql, "member_set_username", u, ` ${name.toUpperCase()} `, k);
      expect(first).toMatchObject({ username: name });
      expect(await rpc(sql, "member_set_username", u, name.toUpperCase(), k)).toMatchObject({
        username: name,
        replayed: true,
      });
      expect(
        Number(
          await val(
            sql`SELECT count(*) FROM public.audit_log WHERE action = 'member_username_set' AND entity_id = ${u}`,
          ),
        ),
      ).toBe(1);
      // once only: it is the referral code
      expect(failedWith(await attempt(setName(u, tag())), "username_already_set")).toBe(true);
      // unique, whatever the case
      const other = await mkUser(sql, "customer");
      expect(failedWith(await attempt(setName(other, name.toUpperCase())), "username_taken")).toBe(
        true,
      );
      expect(failedWith(await attempt(setName(other, "Admin")), "username_reserved")).toBe(true);
      expect(failedWith(await attempt(setName(other, "no")), "username_invalid")).toBe(true);
    });

    it("a member cannot write a username (or anyone else's) straight to the table", async () => {
      const u = await mkUser(sql, "customer");
      const r = await attempt(
        asUser(
          sql,
          u,
          async (tx) => tx`UPDATE public.profiles SET username = ${tag()} WHERE id = ${u}`,
        ),
      );
      expect(r.ok).toBe(false);
      expect(await val(sql`SELECT username FROM public.profiles WHERE id = ${u}`)).toBeNull();
    });

    it("sign-up stores the username; a taken one never blocks the account", async () => {
      const name = tag();
      const a = await signUp({ full_name: "A One", username: name.toUpperCase() });
      expect(await val(sql`SELECT username FROM public.profiles WHERE id = ${a}`)).toBe(name);
      const b = await signUp({ full_name: "B Two", username: name });
      expect(await val(sql`SELECT username FROM public.profiles WHERE id = ${b}`)).toBeNull();
      expect(await val(sql`SELECT count(*)::int FROM public.profiles WHERE id = ${b}`)).toBe(1);
      const c = await signUp({ full_name: "C Three", username: "admin" });
      expect(await val(sql`SELECT username FROM public.profiles WHERE id = ${c}`)).toBeNull();
      // the username is not left in the session-visible metadata
      expect(
        await val(sql`SELECT raw_user_meta_data ? 'username' FROM auth.users WHERE id = ${a}`),
      ).toBe(false);
    });
  });

  describe("referrals", () => {
    const referrer = async (verified = true) => {
      const id = verified ? await mkMember(sql) : await mkUser(sql, "customer");
      const name = tag();
      await setName(id, name);
      return { id, name };
    };

    it("a code is valid only for a verified member (or staff) with a username", async () => {
      const ok = await referrer(true);
      expect(await rpc(sql, "referral_code_check", ok.name.toUpperCase())).toMatchObject({
        valid: true,
      });
      const unverified = await referrer(false);
      expect(await rpc(sql, "referral_code_check", unverified.name)).toMatchObject({
        valid: false,
        reason: "inactive",
      });
      expect(await rpc(sql, "referral_code_check", tag())).toMatchObject({
        valid: false,
        reason: "not_found",
      });
      expect(await rpc(sql, "referral_code_check", "!!")).toMatchObject({
        valid: false,
        reason: "invalid",
      });
      const staff = await mkUser(sql, "budtender");
      const sn = tag();
      await setName(staff, sn);
      expect(await rpc(sql, "referral_code_check", sn)).toMatchObject({ valid: true });
    });

    it("sign-up with a referral code records a pending referral; a bad or inactive code records nothing", async () => {
      const r = await referrer(true);
      const friend = await signUp({
        full_name: "Friend One",
        username: tag(),
        referral_code: r.name.toUpperCase(),
      });
      expect(await referralOf(friend)).toMatchObject({ referrer_id: r.id, status: "pending" });
      const stranger = await signUp({ full_name: "Friend Two", referral_code: tag() });
      expect(await referralOf(stranger)).toBeNull();
      const inactive = await referrer(false);
      const third = await signUp({ full_name: "Friend Three", referral_code: inactive.name });
      expect(await referralOf(third)).toBeNull();
      // a member cannot refer themselves (the code is their own username)
      const self = tag();
      const s = await signUp({ full_name: "Self", username: self, referral_code: self });
      expect(await referralOf(s)).toBeNull();
    });

    it("the referrer earns 1 point when the friend has spent R50, once, however many sales follow", async () => {
      const r = await referrer(true);
      const friend = await signUp({ full_name: "Spender", referral_code: r.name });
      await sql`INSERT INTO public.user_roles (user_id, role) VALUES (${friend}, 'customer'::public.app_role) ON CONFLICT DO NOTHING`;
      const p = await graded("Greenhouse", "Pre-rolls", 30);
      // R30: under R50, nothing yet
      const s1 = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(30)], {
        customer: friend,
      });
      await rpc(sql, "accrue_pos_loyalty", s1.sale_id);
      expect(await referralOf(friend)).toMatchObject({ status: "pending" });
      expect((await loyaltyOf(sql, r.id))?.points_balance ?? 0).toBe(0);
      // another R30: R60 in total, the referral qualifies
      const s2 = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(30)], {
        customer: friend,
      });
      await rpc(sql, "accrue_pos_loyalty", s2.sale_id);
      expect(await referralOf(friend)).toMatchObject({ status: "qualified" });
      expect((await loyaltyOf(sql, r.id))?.points_balance).toBe(1);
      // later sales, retries and re-checks never pay again
      const s3 = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 3 }], [cash(90)], {
        customer: friend,
      });
      await rpc(sql, "accrue_pos_loyalty", s3.sale_id);
      await rpc(sql, "accrue_pos_loyalty", s2.sale_id);
      expect((await loyaltyOf(sql, r.id))?.points_balance).toBe(1);
      expect(
        Number(
          await val(
            sql`SELECT count(*) FROM public.loyalty_transactions WHERE user_id = ${r.id} AND source_type = 'referral'`,
          ),
        ),
      ).toBe(1);
      expect(
        Number(
          await val(
            sql`SELECT count(*) FROM public.audit_log WHERE action = 'referral_qualified' AND actor_user_id = ${r.id}`,
          ),
        ),
      ).toBe(1);
    });

    it("an online order the friend completes counts too, and the summary shows the result", async () => {
      const r = await referrer(true);
      const friend = await signUp({
        full_name: "Online Friend",
        first_name: "Online",
        last_name: "Friend",
        referral_code: r.name,
      });
      await verifyDirect(sql, friend);
      await earnPoints(sql, manager, friend, 2); // an R100 order, completed
      expect(await referralOf(friend)).toMatchObject({ status: "qualified" });
      expect((await loyaltyOf(sql, r.id))?.points_balance).toBe(1);
      const sum = await rpc(sql, "member_rewards_summary", r.id);
      expect(sum).toMatchObject({ username: r.name, can_refer: true, points_from_referrals: 1 });
      expect(sum.referred[0]).toMatchObject({
        status: "qualified",
        name: "Online F.",
      });
      expect(sum.rewards.map((x: { code: string }) => x.code)).toEqual([
        "greenhouse_free",
        "indoor_free",
      ]);
    });

    it("mutation check: without the eligibility rule an unverified member's code would be accepted", async () => {
      const unverified = await referrer(false);
      const rolledBack = new Error("rollback");
      const out = await sql
        .begin(async (tx) => {
          await tx.unsafe(
            "CREATE OR REPLACE FUNCTION public._referral_eligible(p_user uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$",
          );
          expect(
            await rpc(tx as unknown as Sql, "referral_code_check", unverified.name),
          ).toMatchObject({ valid: true });
          throw rolledBack;
        })
        .catch((e) => e);
      expect(out).toBe(rolledBack);
      expect(await rpc(sql, "referral_code_check", unverified.name)).toMatchObject({
        valid: false,
      });
    });
  });

  describe("earning at 1 point per R50", () => {
    it("credits whole points on what was paid, and nothing under R50", async () => {
      const m = await mkMember(sql);
      const p = await graded("Greenhouse", "Pre-rolls", 120);
      const s = await sell(sql, cashier, sessionId, [{ product_id: p, quantity: 1 }], [cash(120)], {
        customer: m,
      });
      expect(await rpc(sql, "accrue_pos_loyalty", s.sale_id)).toMatchObject({
        accrued: true,
        points: 2,
      });
      const small = await graded("Greenhouse", "Pre-rolls", 49);
      const s2 = await sell(
        sql,
        cashier,
        sessionId,
        [{ product_id: small, quantity: 1 }],
        [cash(49)],
        { customer: m },
      );
      expect(await rpc(sql, "accrue_pos_loyalty", s2.sale_id)).toMatchObject({
        accrued: false,
        reason: "no_points",
      });
    });
  });

  describe("rewards at the till", () => {
    const memberWith = async (points: number) => {
      const m = await mkMember(sql);
      if (points > 0) await earnPoints(sql, manager, m, points);
      return m;
    };
    const redeem = (
      m: string | null,
      product: string,
      reward = "greenhouse_free",
      extra: object = {},
    ) =>
      sell(sql, cashier, sessionId, [{ product_id: product, quantity: 1, reward, ...extra }], [], {
        customer: m,
      });

    it("5 points make one Greenhouse item free: R0 sale, points deducted in the same sale, audited", async () => {
      const m = await memberWith(5);
      const p = await graded("Greenhouse", "Pre-rolls", 50);
      const s = await redeem(m, p);
      expect(Number(s.total)).toBe(0);
      expect(s.reward_points).toBe(5);
      expect((await loyaltyOf(sql, m))?.points_balance).toBe(0);
      expect(
        await sql`SELECT txn_type, source_type, points FROM public.loyalty_transactions WHERE user_id = ${m} AND source_type = 'pos_reward'`,
      ).toEqual([{ txn_type: "redeem", source_type: "pos_reward", points: -5 }]);
      const [row] =
        await sql`SELECT discount_reason, discount_rand FROM public.pos_sales WHERE id = ${s.sale_id}`;
      expect(row).toMatchObject({ discount_reason: "Loyalty reward" });
      expect(Number(row!["discount_rand"])).toBe(50);
      expect(
        await val(
          sql`SELECT metadata->>'reward_points' FROM public.audit_log WHERE action = 'pos_sale_discount' AND entity_id = ${s.sale_id}`,
        ),
      ).toBe("5");
      // stock still goes out
      expect(
        Number(
          await val(
            sql`SELECT COALESCE(sum(quantity_delta),0) FROM public.inventory_ledger WHERE product_id = ${p}`,
          ),
        ),
      ).toBe(49);
    });

    it("works on flower too (1 g), and 10 points make a free Entry Indoor item", async () => {
      const m = await memberWith(10);
      const flower = await graded("Entry Indoor", "Flower", 100);
      const s = await redeem(m, flower, "indoor_free");
      expect(Number(s.total)).toBe(0);
      expect((await loyaltyOf(sql, m))?.points_balance).toBe(0);
    });

    it("only one unit is free: the rest of the line is paid, with the member's other items", async () => {
      const m = await memberWith(5);
      const p = await graded("Greenhouse", "Pre-rolls", 50);
      const other = await graded("Greendoor", "Pre-rolls", 70);
      const s = await sell(
        sql,
        cashier,
        sessionId,
        [
          { product_id: p, quantity: 3, reward: "greenhouse_free" },
          { product_id: other, quantity: 1 },
        ],
        [cash(170)], // 2 x 50 + 70
        { customer: m },
      );
      expect(Number(s.total)).toBe(170);
      expect(Number(s.discount)).toBe(50);
    });

    it("needs enough points, a member, an eligible product and no other discount on that line", async () => {
      const poor = await memberWith(4);
      const gh = await graded("Greenhouse", "Pre-rolls", 50);
      expect(failedWith(await attempt(redeem(poor, gh)), "insufficient_points")).toBe(true);
      expect((await loyaltyOf(sql, poor))?.points_balance).toBe(4); // nothing was taken, no sale was made
      const m = await memberWith(10);
      expect(failedWith(await attempt(redeem(null, gh)), "reward_needs_member")).toBe(true);
      const wrongGrade = await graded("Greendoor", "Pre-rolls", 70);
      expect(failedWith(await attempt(redeem(m, wrongGrade)), "reward_not_eligible")).toBe(true);
      const indoor = await graded("Entry Indoor", "Pre-rolls", 100);
      expect(
        failedWith(await attempt(redeem(m, indoor, "greenhouse_free")), "reward_not_eligible"),
      ).toBe(true);
      const edible = await graded("Greenhouse", "Edibles", 50);
      expect(failedWith(await attempt(redeem(m, edible)), "reward_not_eligible")).toBe(true);
      expect(failedWith(await attempt(redeem(m, gh, "no_such_reward")), "reward_unavailable")).toBe(
        true,
      );
      expect(
        failedWith(
          await attempt(
            redeem(m, gh, "greenhouse_free", { discount: { kind: "percent", value: "10" } }),
          ),
          "invalid_discount",
        ),
      ).toBe(true);
      expect((await loyaltyOf(sql, m))?.points_balance).toBe(10);
    });

    it("two rewards in one sale cost the sum, and cannot be paid for twice on a retry", async () => {
      const m = await memberWith(15);
      const gh = await graded("Greenhouse", "Pre-rolls", 50);
      const ind = await graded("Entry Indoor", "Pre-rolls", 100);
      const k = key("two");
      const items = [
        { product_id: gh, quantity: 1, reward: "greenhouse_free" },
        { product_id: ind, quantity: 1, reward: "indoor_free" },
      ];
      const s = await sell(sql, cashier, sessionId, items, [], { customer: m, idem: k });
      expect(s.reward_points).toBe(15);
      const again = await sell(sql, cashier, sessionId, items, [], { customer: m, idem: k });
      expect(again.sale_id).toBe(s.sale_id);
      expect((await loyaltyOf(sql, m))?.points_balance).toBe(0);
    });

    it("voiding the sale gives the points back, once, and a spent balance cannot be double-spent", async () => {
      const m = await memberWith(5);
      const gh = await graded("Greenhouse", "Pre-rolls", 50);
      const s = await redeem(m, gh);
      // a second reward with no points left is refused
      expect(failedWith(await attempt(redeem(m, gh)), "insufficient_points")).toBe(true);
      const v = await rpc(sql, "pos_void_sale", manager, s.sale_id, "Wrong item", key("void"));
      expect(v.reward_points_restored).toBe(5);
      expect((await loyaltyOf(sql, m))?.points_balance).toBe(5);
      expect(
        failedWith(
          await attempt(rpc(sql, "pos_void_sale", manager, s.sale_id, "again", key("void2"))),
          "invalid_sale_state",
        ),
      ).toBe(true);
      expect((await loyaltyOf(sql, m))?.points_balance).toBe(5);
      // and it can be used again
      expect(Number((await redeem(m, gh)).total)).toBe(0);
    });

    it("a reward works for staff on a staff-rate sale (the free item is not discounted twice)", async () => {
      const staff = await mkUser(sql, "budtender");
      await earnPoints(sql, manager, staff, 5);
      const gh = await graded("Greenhouse", "Pre-rolls", 50);
      const other = await graded("Greendoor", "Pre-rolls", 100);
      // staff is attached by a manager (budtenders cannot attach themselves)
      const mgrSession = (await mkSession(sql, manager, manager)).sessionId;
      const s = await sell(
        sql,
        manager,
        mgrSession,
        [
          { product_id: gh, quantity: 1, reward: "greenhouse_free" },
          { product_id: other, quantity: 1 },
        ],
        [cash(80)], // 100 less the 20% staff rate; the free item stays free
        { customer: staff },
      );
      expect(Number(s.total)).toBe(80);
      expect(s.staff_purchase).toBe(true);
    });

    it("points are not earned on a free item, and the rate for what is paid is unchanged", async () => {
      const m = await memberWith(5);
      const gh = await graded("Greenhouse", "Pre-rolls", 50);
      const paid = await graded("Greendoor", "Pre-rolls", 100);
      const s = await sell(
        sql,
        cashier,
        sessionId,
        [
          { product_id: gh, quantity: 1, reward: "greenhouse_free" },
          { product_id: paid, quantity: 1 },
        ],
        [cash(100)],
        { customer: m },
      );
      expect(await rpc(sql, "accrue_pos_loyalty", s.sale_id)).toMatchObject({
        accrued: true,
        points: 2,
      });
    });

    it("the till can look up a member's points and the rewards on offer", async () => {
      const m = await memberWith(7);
      const r = await rpc(sql, "pos_customer_rewards", cashier, m);
      expect(r.points).toBe(7);
      expect(
        r.rewards.map((x: { code: string; points_cost: number }) => [x.code, x.points_cost]),
      ).toEqual([
        ["greenhouse_free", 5],
        ["indoor_free", 10],
      ]);
      expect((await attempt(rpc(sql, "pos_customer_rewards", m, m))).ok).toBe(false); // staff only
    });

    it("the till search finds a member by username", async () => {
      const m = await mkMember(sql);
      const name = tag();
      await setName(m, name);
      const rows = await rpc<{ id: string; username: string }[]>(
        sql,
        "pos_customer_search",
        cashier,
        name.slice(0, 8),
        10,
      );
      expect(rows.find((x) => x.id === m)?.username).toBe(name);
    });

    it("mutation check: without the eligibility rule any product could be claimed as a free reward", async () => {
      const m = await memberWith(5);
      const edible = await graded("Greenhouse", "Edibles", 50);
      const rolledBack = new Error("rollback");
      const out = await sql
        .begin(async (tx) => {
          await tx.unsafe(
            "CREATE OR REPLACE FUNCTION public._reward_eligible(p_reward text, p_product uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$",
          );
          const s = await sell(
            tx as unknown as Sql,
            cashier,
            sessionId,
            [{ product_id: edible, quantity: 1, reward: "greenhouse_free" }],
            [],
            { customer: m },
          );
          expect(Number(s.total)).toBe(0);
          throw rolledBack;
        })
        .catch((e) => e);
      expect(out).toBe(rolledBack);
      expect(failedWith(await attempt(redeem(m, edible)), "reward_not_eligible")).toBe(true);
    });
  });

  it("the rewards catalogue is readable by signed-in members only, and the new tables take no browser writes", async () => {
    const m = await mkMember(sql);
    const rows = await asUser(
      sql,
      m,
      async (tx) => tx`SELECT code FROM public.loyalty_rewards ORDER BY sort_order`,
    );
    expect(rows.map((r) => r["code"])).toEqual(["greenhouse_free", "indoor_free"]);
    expect(
      (
        await attempt(
          asUser(sql, m, async (tx) => tx`UPDATE public.loyalty_rewards SET points_cost = 1`),
        )
      ).ok,
    ).toBe(false);
    expect(
      (await attempt(asUser(sql, m, async (tx) => tx`SELECT * FROM public.referrals`))).ok,
    ).toBe(false);
    for (const fn of [
      "member_set_username",
      "username_check",
      "referral_code_check",
      "member_rewards_summary",
      "pos_customer_rewards",
      "_referral_check",
    ]) {
      const [g] =
        await sql`SELECT bool_or(has_function_privilege('authenticated', p.oid, 'execute') OR has_function_privilege('anon', p.oid, 'execute')) AS ok
                            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ${fn}`;
      expect(g!["ok"], fn).toBe(false);
    }
  });

  it("the tier thresholds follow the new rate and the earn rule is R50", async () => {
    expect(
      Number(
        await val(sql`SELECT value FROM public.loyalty_rules WHERE code = 'earn_rand_per_point'`),
      ),
    ).toBe(50);
    expect(
      (
        await sql`SELECT code, min_lifetime_points FROM public.loyalty_tiers ORDER BY min_lifetime_points`
      ).map((t) => [t["code"], t["min_lifetime_points"]]),
    ).toEqual([
      ["seed", 0],
      ["sprout", 100],
      ["bloom", 400],
      ["canopy", 1000],
    ]);
  });
});
