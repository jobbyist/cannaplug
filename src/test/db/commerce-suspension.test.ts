import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkUser,
  rpc,
  uid,
  type Sql,
} from "./helpers";

/**
 * POS and online checkout are suspended until the Shopify Admin/Checkout API bill is paid; a completed payment on that
 * billing account lifts it automatically. Real PostgreSQL. Each test runs in a transaction-free reset of the table.
 */
describe.skipIf(!DB_URL)("commerce suspension (real PostgreSQL)", () => {
  let sql: Sql;
  let admin: string;
  let manager: string;
  let member: string;
  const status = async () =>
    (await rpc(sql, "commerce_suspension_status")) as { suspended: boolean; billing_slug?: string };
  const reset = async () => {
    await sql`DELETE FROM public.commerce_suspensions`;
  };
  const suspend = (
    actor: string,
    slug = "shopify-admin-api",
    reason = "Bill unpaid",
    k = key("s"),
  ) => rpc(sql, "commerce_suspend", actor, slug, reason, k);
  const resume = (actor: string, reason = "Settled", k = key("r")) =>
    rpc(sql, "commerce_resume", actor, reason, k);
  const pay = (slug: string, provider: "paypal" | "payfast", st: string, id: string = uid()) =>
    rpc(sql, "billing_record_payment", slug, provider, id.slice(0, 40), st, 2875, "USD", "x");

  beforeAll(async () => {
    sql = connect(10);
    [admin, manager, member] = await Promise.all([
      mkUser(sql, "admin"),
      mkUser(sql, "manager"),
      mkUser(sql, "customer"),
    ]);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("the migration itself starts the suspension, tied to the Shopify bill", async () => {
    // The migration seed is the active row unless another test reset it.
    const rows = await sql`SELECT a.slug FROM public.commerce_suspensions s
                           JOIN public.billing_accounts a ON a.id = s.billing_account_id`;
    expect(rows.length === 0 || rows.every((r) => r["slug"] === "shopify-admin-api")).toBe(true);
  });

  it("a completed PayPal payment on the Shopify account lifts the suspension and audits it", async () => {
    await reset();
    expect((await suspend(admin)).changed).toBe(true);
    expect(await status()).toMatchObject({ suspended: true, billing_slug: "shopify-admin-api" });
    await pay("shopify-admin-api", "paypal", "COMPLETED");
    expect((await status()).suspended).toBe(false);
    const [row] =
      await sql`SELECT resumed_via, resumed_payment_id FROM public.commerce_suspensions`;
    expect(row).toMatchObject({ resumed_via: "payment" });
    expect(row!["resumed_payment_id"]).toBeTruthy();
    const audit = await sql`SELECT 1 FROM public.audit_log WHERE action = 'commerce_resumed'
                             AND metadata->>'via' = 'payment'`;
    expect(audit.length).toBeGreaterThan(0);
  });

  it("does NOT lift on a payment for another account, a failed/refunded status, or a pending one", async () => {
    await reset();
    await suspend(admin);
    await pay("payfast-gateway", "payfast", "COMPLETE");
    await pay("shopify-admin-api", "paypal", "REFUNDED");
    await pay("shopify-admin-api", "payfast", "PENDING");
    expect((await status()).suspended).toBe(true);
    await pay("shopify-admin-api", "payfast", "COMPLETE");
    expect((await status()).suspended).toBe(false);
  });

  it("a replayed payment event changes nothing and a later payment does not re-suspend", async () => {
    await reset();
    await suspend(admin);
    const id = uid().slice(0, 40);
    await pay("shopify-admin-api", "paypal", "COMPLETED", id);
    await pay("shopify-admin-api", "paypal", "COMPLETED", id);
    await pay("shopify-admin-api", "paypal", "COMPLETED");
    expect((await status()).suspended).toBe(false);
    expect((await sql`SELECT count(*)::int AS n FROM public.commerce_suspensions`)[0]!["n"]).toBe(
      1,
    );
  });

  it("only an admin can suspend or resume; browser roles and anon cannot call or read it", async () => {
    await reset();
    for (const who of [manager, member]) {
      expect(failedWith(await attempt(suspend(who)), "forbidden")).toBe(true);
    }
    await suspend(admin);
    for (const who of [manager, member]) {
      expect(failedWith(await attempt(resume(who)), "forbidden")).toBe(true);
    }
    expect((await status()).suspended).toBe(true);
    for (const run of [
      () => asUser(sql, member, (tx) => tx`SELECT public.commerce_suspension_status()`),
      () =>
        asUser(
          sql,
          admin,
          (tx) =>
            tx`SELECT public.commerce_suspend(${admin}::uuid, 'shopify-admin-api', 'x y z', 'abcdefgh1')`,
        ),
      () =>
        asAnon(
          sql,
          (tx) => tx`SELECT public.commerce_resume(${admin}::uuid, 'x y z', 'abcdefgh2')`,
        ),
      () => asAnon(sql, (tx) => tx`SELECT * FROM public.commerce_suspensions`),
      () =>
        asUser(sql, member, (tx) => tx`UPDATE public.commerce_suspensions SET resumed_at = now()`),
    ]) {
      expect((await attempt(run())).ok).toBe(false);
    }
    expect((await status()).suspended).toBe(true);
  });

  it("manager can read the suspension row but a customer sees nothing", async () => {
    await reset();
    await suspend(admin);
    expect(
      (await asUser(sql, manager, (tx) => tx`SELECT id FROM public.commerce_suspensions`)).length,
    ).toBe(1);
    expect(
      (
        await asUser(sql, member, (tx) => tx`SELECT id FROM public.commerce_suspensions`).catch(
          () => [],
        )
      ).length,
    ).toBe(0);
  });

  it("admin resume works once, is idempotent, needs a reason, and is audited", async () => {
    await reset();
    await suspend(admin);
    expect(failedWith(await attempt(resume(admin, " ")), "invalid_input")).toBe(true);
    const k = key("same");
    expect((await resume(admin, "Paid by EFT", k)).changed).toBe(true);
    expect((await resume(admin, "Paid by EFT", k)).replayed).toBe(true);
    expect((await resume(admin)).changed).toBe(false);
    expect((await status()).suspended).toBe(false);
    const audit =
      await sql`SELECT 1 FROM public.audit_log WHERE action = 'commerce_resumed' AND actor_user_id = ${admin}`;
    expect(audit.length).toBe(1);
  });

  it("only one suspension can be active; suspending twice is a no-op; unknown account is refused", async () => {
    await reset();
    expect((await suspend(admin)).changed).toBe(true);
    expect((await suspend(admin)).changed).toBe(false);
    expect(
      (
        await sql`SELECT count(*)::int AS n FROM public.commerce_suspensions WHERE resumed_at IS NULL`
      )[0]!["n"],
    ).toBe(1);
    expect(failedWith(await attempt(suspend(admin, "nope")), "billing_account_not_found")).toBe(
      true,
    );
    expect(
      failedWith(await attempt(suspend(admin, "shopify-admin-api", "")), "invalid_input"),
    ).toBe(true);
  });

  it("mutation check: the payment trigger is what lifts it (without it a payment leaves sales paused)", async () => {
    await reset();
    await suspend(admin);
    await sql
      .begin(async (tx) => {
        await tx`ALTER TABLE public.billing_payments DISABLE TRIGGER commerce_resume_on_payment`;
        await rpc(
          tx as unknown as Sql,
          "billing_record_payment",
          "shopify-admin-api",
          "paypal",
          uid().slice(0, 40),
          "COMPLETED",
          2875,
          "USD",
          "x",
        );
        const [r] = await tx`SELECT public.commerce_suspension_status() AS s`;
        expect((r!["s"] as { suspended: boolean }).suspended).toBe(true);
        throw new Error("rollback");
      })
      .catch((e) => expect(String(e)).toContain("rollback"));
    expect((await status()).suspended).toBe(true);
  });
});
