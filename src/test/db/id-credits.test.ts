import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DB_URL, attempt, connect, key, mkUser, rpc, uid, val, type Sql } from "./helpers";

/**
 * ID-check credits: 3 per new member at their first ID submission, 400 opening + 558 reserved for imports,
 * a low-balance email at <= 100 to admin@ and info@, and new ID submissions refused when credits are out.
 */
describe.skipIf(!DB_URL)("ID-check credits (real PostgreSQL)", () => {
  let sql: Sql;
  let staff: string;
  let admin: string;
  beforeAll(async () => {
    sql = connect(10);
    staff = await mkUser(sql, "budtender");
    admin = await mkUser(sql, "admin");
  });
  afterAll(async () => {
    await sql.end();
  });

  // Each test starts from a known balance: the ledger is append-only, so movements are added, never removed.
  const balance = async () =>
    (await sql`SELECT * FROM public._id_credit_balance()`)[0] as unknown as {
      total: number;
      reserved: number;
      available: number;
    };
  const setAvailable = async (target: number) => {
    const b = await balance();
    if (b.available !== target)
      await sql`INSERT INTO public.id_credit_ledger (kind, credits, note)
                VALUES ('adjustment', ${target - b.available}, 'test setup')`;
    await sql`UPDATE public.id_credit_settings SET low_alert_sent_at = NULL`;
  };
  beforeEach(async () => {
    await setAvailable(400);
  });

  /** A member submitting their ID exactly as the app does. */
  const submit = (member: string) =>
    rpc(
      sql,
      "verification_submit",
      member,
      "sa_id",
      `${member}/${uid()}.jpg`,
      "1990-01-01",
      null,
      key("id"),
    );
  const imported = async () => {
    const id = uid();
    await sql`INSERT INTO auth.users (id, email, raw_app_meta_data)
              VALUES (${id}, ${`imp-${id}@test.local`}, '{"source":"customer_import"}')`;
    return id;
  };
  const alerts = () =>
    val<string>(
      sql`SELECT count(*) FROM public.notification_events WHERE template = 'id_credits_low'`,
    ).then(Number);

  it("seeds 400 for new sign-ups plus 558 reserved for the 186 imported members", async () => {
    const seed = await sql`SELECT kind, credits, reserved_delta FROM public.id_credit_ledger
                           WHERE idempotency_key LIKE 'seed:%' ORDER BY id`;
    expect(seed.map((r) => [r["kind"], r["credits"], r["reserved_delta"]])).toEqual([
      ["opening", 400, 0],
      ["reserve", 558, 558],
    ]);
  });

  it("charges 3 credits once per new member, not again on a resubmission", async () => {
    const member = await mkUser(sql, "customer");
    await submit(member);
    expect((await balance()).available).toBe(397);
    await rpc(sql, "verification_review", staff, member, "reject", "unreadable", null, key("rv"));
    await submit(member);
    expect((await balance()).available).toBe(397);
  });

  it("charges imported members from the reserve; a sign-up cannot claim to be imported", async () => {
    const before = await balance();
    await submit(await imported());
    const after = await balance();
    expect(after.available).toBe(before.available);
    expect(after.reserved).toBe(before.reserved - 3);
    // user_metadata is set by the browser at sign-up, so it must not count.
    const faker = uid();
    await sql`INSERT INTO auth.users (id, email, raw_user_meta_data)
              VALUES (${faker}, ${`fake-${faker}@test.local`}, '{"source":"customer_import"}')`;
    await submit(faker);
    const last = await balance();
    expect(last.available).toBe(after.available - 3);
    expect(last.reserved).toBe(after.reserved);
  });

  it("emails admin@ and info@ once when 100 or fewer credits are left, and again only after a top-up", async () => {
    await setAvailable(103);
    const start = await alerts();
    await submit(await mkUser(sql, "customer")); // 100 left
    expect((await alerts()) - start).toBe(2);
    const to = await sql`SELECT recipient FROM public.notification_events
                         WHERE template = 'id_credits_low' ORDER BY created_at DESC LIMIT 2`;
    expect(to.map((r) => r["recipient"]).sort()).toEqual([
      "admin@cannaplug012.co.za",
      "info@cannaplug012.co.za",
    ]);
    await submit(await mkUser(sql, "customer")); // 97 left: no second email
    expect((await alerts()) - start).toBe(2);
    await rpc(sql, "id_credits_top_up", staff, 200, "INV-1", key("top"));
    expect(
      (await sql`SELECT low_alert_sent_at FROM public.id_credit_settings`)[0]!["low_alert_sent_at"],
    ).toBeNull();
  });

  it("refuses a new member's ID submission when credits are out, and reports sign-up as closed", async () => {
    await setAvailable(2);
    expect(await rpc(sql, "id_credits_open")).toBe(false);
    const member = await mkUser(sql, "customer");
    const r = await attempt(submit(member));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/^id_credits_depleted/);
    // The refused submission left nothing behind (no pending ID, no charge).
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.customer_verification WHERE user_id = ${member} AND status = 'pending'`,
        ),
      ),
    ).toBe(0);
    // Imported members still go through on the reserve.
    await submit(await imported());
    await rpc(sql, "id_credits_top_up", staff, 10, null, key("top"));
    expect(await rpc(sql, "id_credits_open")).toBe(true);
  });

  it("top-ups are open to any staff member and idempotent; the reserve is admin-only; customers get nothing", async () => {
    const customer = await mkUser(sql, "customer");
    const k = key("top");
    await rpc(sql, "id_credits_top_up", staff, 50, "INV-2", k);
    const replay = await rpc(sql, "id_credits_top_up", staff, 50, "INV-2", k);
    expect(replay.replayed).toBe(true);
    expect((await balance()).available).toBe(450);
    expect((await attempt(rpc(sql, "id_credits_top_up", customer, 5, null, key("t")))).ok).toBe(
      false,
    );
    expect((await attempt(rpc(sql, "id_credits_summary", customer))).ok).toBe(false);
    expect((await attempt(rpc(sql, "id_credits_set_reserve", staff, 0, null, key("r")))).ok).toBe(
      false,
    );
    const b = await balance();
    await rpc(sql, "id_credits_set_reserve", admin, b.reserved - 30, "Import used fewer", key("r"));
    expect((await balance()).available).toBe(b.available + 30);
    expect(
      Number(
        await val(
          sql`SELECT count(*) FROM public.audit_log WHERE action IN ('id_credits_topped_up', 'id_credits_reserve_set')`,
        ),
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it("the summary shows balances and no member identities", async () => {
    await submit(await mkUser(sql, "customer"));
    const s = await rpc(sql, "id_credits_summary", staff);
    expect(s.cost_per_check).toBe(3);
    expect(s.low_balance_threshold).toBe(100);
    expect(JSON.stringify(s.recent)).not.toMatch(/member_user_id|@test\.local/);
  });

  it("the ledger is append-only and closed to browsers", async () => {
    expect((await attempt(sql`DELETE FROM public.id_credit_ledger`)).ok).toBe(false);
    expect((await attempt(sql`UPDATE public.id_credit_ledger SET credits = 0`)).ok).toBe(false);
    const grants =
      await sql`SELECT has_table_privilege('authenticated', 'public.id_credit_ledger', 'SELECT') AS s,
                                    has_table_privilege('anon', 'public.id_credit_settings', 'SELECT') AS a`;
    expect(grants[0]).toMatchObject({ s: false, a: false });
  });
});
