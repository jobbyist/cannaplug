import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkUser,
  rpc,
  type Sql,
} from "./helpers";

/** A bill paid outside the billing system, recorded by an admin. Real PostgreSQL. */
describe.skipIf(!DB_URL)("manual billing payments (real PostgreSQL)", () => {
  let sql: Sql;
  let admin: string;
  let manager: string;
  beforeAll(async () => {
    sql = connect(10);
    [admin, manager] = [await mkUser(sql, "admin"), await mkUser(sql, "manager")];
  });
  afterAll(async () => {
    await sql.end();
  });

  const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10); // SAST date
  const record = (actor: string, over: Record<string, unknown> = {}, k = key("pay")) => {
    const a = {
      slug: "shopify-admin-api",
      cents: 2875,
      currency: "USD",
      paid_on: today(),
      note: "Paid directly to Shopify by card",
      ...over,
    };
    return rpc(
      sql,
      "billing_record_manual_payment",
      actor,
      a.slug,
      a.cents,
      a.currency,
      a.paid_on,
      a.note,
      k,
    );
  };
  const shopifyPayments = async () =>
    sql`SELECT p.* FROM public.billing_payments p JOIN public.billing_accounts a ON a.id = p.account_id
        WHERE a.slug = 'shopify-admin-api' AND p.provider = 'manual' ORDER BY p.created_at`;

  it("an admin records a paid bill once: COMPLETE, manual, dated, audited, developer notified", async () => {
    const before = (await shopifyPayments()).length;
    const k = key("pay");
    const out = await record(admin, {}, k);
    expect(out).toMatchObject({ recorded: true });
    expect(await record(admin, {}, k)).toEqual(out); // replay
    const rows = await shopifyPayments();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ status: "COMPLETE", amount_cents: 2875, currency: "USD" });
    expect(rows.at(-1)!["item_name"]).toBe("Manual payment: Paid directly to Shopify by card");
    const [audit] = await sql`SELECT actor_user_id FROM public.audit_log
      WHERE action = 'billing_payment_recorded_manual' ORDER BY created_at DESC LIMIT 1`;
    expect(audit!["actor_user_id"]).toBe(admin);
    const [n] = await sql`SELECT count(*)::int AS n FROM public.notification_events
      WHERE template = 'staff_billing_payment' AND dedupe_key LIKE ${`billing_payment:${out.payment_id}:%`}`;
    expect(n!["n"]).toBeGreaterThan(0);
  });

  it("a past payment is dated to that day (midday SAST)", async () => {
    const d = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    const out = await record(admin, { paid_on: d });
    const [row] =
      await sql`SELECT created_at FROM public.billing_payments WHERE id = ${out.payment_id}`;
    expect((row!["created_at"] as Date).toISOString()).toBe(`${d}T10:00:00.000Z`);
  });

  it("lifts an active suspension on that account, like any completed payment", async () => {
    await sql`UPDATE public.commerce_suspensions SET resumed_at = now() WHERE resumed_at IS NULL`;
    await rpc(
      sql,
      "commerce_suspend",
      admin,
      "shopify-admin-api",
      "rehearsing a suspension",
      key("s"),
    );
    expect((await rpc(sql, "commerce_suspension_status")).suspended).toBe(true);
    await record(admin);
    expect((await rpc(sql, "commerce_suspension_status")).suspended).toBe(false);
  });

  it("admins only; validates amount, currency, date and note", async () => {
    expect(failedWith(await attempt(record(manager)), "forbidden")).toBe(true);
    const future = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const old = new Date(Date.now() - 120 * 86400_000).toISOString().slice(0, 10);
    for (const bad of [
      { cents: 0 },
      { currency: "EUR" },
      { paid_on: future },
      { paid_on: old },
      { note: "x" },
    ])
      expect(
        failedWith(await attempt(record(admin, bad)), "invalid_input"),
        JSON.stringify(bad),
      ).toBe(true);
    expect(
      failedWith(await attempt(record(admin, { slug: "nope" })), "billing_account_not_found"),
    ).toBe(true);
  });

  it("browsers cannot call it or write billing history", async () => {
    for (const run of [
      (tx: Sql) =>
        tx`SELECT public.billing_record_manual_payment(${admin}, 'shopify-admin-api', 100, 'USD', current_date, 'paid', ${key("b")})`,
      (tx: Sql) =>
        tx`INSERT INTO public.billing_payments (account_id, provider, provider_payment_id, status)
           SELECT id, 'manual', 'x', 'COMPLETE' FROM public.billing_accounts LIMIT 1`,
    ])
      expect((await attempt(asUser(sql, admin, run))).ok).toBe(false);
  });

  it("mutation check: without the admin check a manager could mark a bill paid", async () => {
    const rolledBack = new Error("rollback");
    const out = await sql
      .begin(async (tx) => {
        const rows = (await tx`SELECT pg_get_functiondef(
          'public.billing_record_manual_payment(uuid,text,integer,text,date,text,text)'::regprocedure) AS def`) as unknown as {
          def: string;
        }[];
        const def = rows[0]!.def;
        await tx.unsafe(def.replace("PERFORM public._assert_staff(p_actor, 'admin');", ""));
        const r = await attempt(
          tx`SELECT public.billing_record_manual_payment(${manager}, 'shopify-admin-api', 100, 'USD',
             (now() AT TIME ZONE 'Africa/Johannesburg')::date, 'mutant payment', ${key("m")})`,
        );
        throw Object.assign(rolledBack, { r });
      })
      .catch((e) =>
        e === rolledBack ? (e as Error & { r: { ok: boolean } }).r : Promise.reject(e),
      );
    expect(out.ok).toBe(true); // the mutant lets a manager through: the real check is what stops it
  });
});
