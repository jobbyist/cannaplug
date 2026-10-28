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

describe.skipIf(!DB_URL)("billing dates, alerts and PayPal history (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let budtender: string;
  const rolledBack = Symbol("rollback");
  /** Runs fn in a transaction that is always rolled back, so shared tables (the ID-credit ledger) are untouched. */
  const inRollback = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
    let out!: T;
    await sql
      .begin(async (tx) => {
        out = await fn(tx as unknown as Sql);
        throw rolledBack;
      })
      .catch((e) => {
        if (e !== rolledBack) throw e;
      });
    return out;
  };
  const due = async (kind: string, n: number | null, anchor: string, today: string) =>
    (
      await sql`SELECT public.billing_next_due(${kind}, ${n}, ${anchor}::date, ${today}::date)::text AS d`
    )[0]!["d"];
  const queued = (template: string) =>
    sql`SELECT recipient, data FROM public.notification_events WHERE template = ${template}`;
  const alertRow = (tx: Sql, k: string) =>
    tx`SELECT status, kind, min_role, title, body, alert_count FROM public.team_notifications WHERE source_key = ${k}`;

  beforeAll(async () => {
    sql = connect(10);
    [manager, budtender] = await Promise.all([mkUser(sql, "manager"), mkUser(sql, "budtender")]);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("seeds Supabase and GoDaddy, with the recurrence rules from the billing schedule", async () => {
    const rows =
      await sql`SELECT slug, position, status, payment_kind, recur_kind, recur_n, anchor_date::text AS anchor FROM public.billing_accounts ORDER BY position`;
    expect(rows.map((r) => r["slug"])).toEqual([
      "shopify-admin-api",
      "clinical-documents",
      "email-push",
      "supabase-platform",
      "whatsapp",
      "payfast-gateway",
      "verifynow-id",
      "godaddy-domain",
    ]);
    const by = (s: string) => rows.find((r) => r["slug"] === s)!;
    expect(by("shopify-admin-api")).toMatchObject({
      recur_kind: "every_days",
      recur_n: 30,
      anchor: "2026-10-30",
    });
    expect(by("payfast-gateway")).toMatchObject({ recur_kind: "monthly", anchor: "2026-10-27" });
    expect(by("godaddy-domain")).toMatchObject({
      payment_kind: "manage",
      recur_kind: "yearly",
      anchor: "2027-09-27",
    });
    expect(by("supabase-platform")).toMatchObject({
      status: "active",
      payment_kind: "none",
      recur_kind: null,
    });
    const sb = (
      await sql`SELECT amount_text, schedule_text FROM public.billing_accounts WHERE slug = 'supabase-platform'`
    )[0]!;
    expect(sb["amount_text"]).toBe("Free plan");
    expect(sb["schedule_text"]).toMatch(/\$20\/month/);
    const gd = (
      await sql`SELECT amount_text FROM public.billing_accounts WHERE slug = 'godaddy-domain'`
    )[0]!;
    expect(gd["amount_text"]).toBe("R163.99 per year");
  });

  it("billing_next_due: every 30 days from 30 Oct, monthly on the 27th, yearly, month-end clamping", async () => {
    expect(await due("every_days", 30, "2026-10-30", "2026-10-28")).toBe("2026-10-30");
    expect(await due("every_days", 30, "2026-10-30", "2026-10-31")).toBe("2026-11-29");
    expect(await due("every_days", 30, "2026-10-30", "2026-11-30")).toBe("2026-12-29");
    expect(await due("every_days", 30, "2026-10-30", "2026-12-30")).toBe("2027-01-28");
    expect(await due("every_days", 30, "2026-10-30", "2027-01-29")).toBe("2027-02-27");
    expect(await due("every_days", 30, "2026-10-30", "2027-02-28")).toBe("2027-03-29");
    expect(await due("monthly", null, "2026-10-27", "2026-10-28")).toBe("2026-11-27");
    expect(await due("monthly", null, "2026-10-27", "2026-11-27")).toBe("2026-11-27");
    expect(await due("monthly", null, "2026-10-27", "2026-12-28")).toBe("2027-01-27");
    expect(await due("monthly", null, "2026-01-31", "2026-02-01")).toBe("2026-02-28");
    expect(await due("monthly", null, "2026-01-31", "2028-02-01")).toBe("2028-02-29");
    expect(await due("yearly", null, "2027-09-27", "2026-10-28")).toBe("2027-09-27");
    expect(await due("yearly", null, "2027-09-27", "2027-09-28")).toBe("2028-09-27");
    expect(await due("yearly", null, "2028-02-29", "2029-01-01")).toBe("2029-02-28");
    expect(await due("nope", null, "2026-10-30", "2026-10-28")).toBeNull();
  });

  it("a bill due tomorrow (SAST) raises one manager alert, which archives itself when the date passes or the account is paused", async () => {
    await inRollback(async (tx) => {
      const k = "alert:bill-due:shopify-admin-api";
      const today = (
        await tx`SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS d`
      )[0]!["d"];
      await tx`UPDATE public.billing_accounts SET anchor_date = ${today}::date + 1 WHERE slug = 'shopify-admin-api'`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      const [row] = await alertRow(tx, k);
      expect(row).toMatchObject({
        status: "published",
        kind: "reminder",
        min_role: "manager",
        alert_count: 1,
      });
      expect(row!["title"]).toMatch(/^Bill due tomorrow: /);
      expect(row!["body"]).toMatch(/Shopify: .* is due on \d{1,2} \w+ \d{4}\./);
      // nothing changes on a second run
      expect((await tx`SELECT public.billing_due_alerts_refresh() AS n`)[0]!["n"]).toBe(0);
      // two days out: not yet
      await tx`UPDATE public.billing_accounts SET anchor_date = ${today}::date + 2 WHERE slug = 'shopify-admin-api'`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      expect((await alertRow(tx, k))[0]!["status"]).toBe("archived");
      // due tomorrow again, then paused: archived
      await tx`UPDATE public.billing_accounts SET anchor_date = ${today}::date + 1 WHERE slug = 'shopify-admin-api'`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      expect((await alertRow(tx, k))[0]!["status"]).toBe("published");
      await tx`UPDATE public.billing_accounts SET status = 'paused' WHERE slug = 'shopify-admin-api'`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      expect((await alertRow(tx, k))[0]!["status"]).toBe("archived");
      // only accounts with a rule alert: Supabase (free, no rule) never does
      expect(await alertRow(tx, "alert:bill-due:supabase-platform")).toHaveLength(0);
    });
  });

  it("ID verification credits below the threshold raise an alert straight away, and a top-up clears it", async () => {
    await inRollback(async (tx) => {
      const k = "alert:id-credits";
      const avail = async () =>
        (await tx`SELECT available FROM public._id_credit_balance()`)[0]!["available"] as number;
      const threshold = (await tx`SELECT low_balance_threshold FROM public.id_credit_settings`)[0]![
        "low_balance_threshold"
      ] as number;
      expect(threshold).toBe(100);
      // 150 left: no alert
      await tx`INSERT INTO public.id_credit_ledger (kind, credits, reserved_delta, note) VALUES ('adjustment', ${150 - (await avail())}, 0, 'test')`;
      expect(await avail()).toBe(150);
      expect((await alertRow(tx, k))[0]?.["status"] ?? "archived").toBe("archived");
      // exactly 100: not below, so no alert
      await tx`INSERT INTO public.id_credit_ledger (kind, credits, reserved_delta, note) VALUES ('adjustment', -50, 0, 'test')`;
      expect((await alertRow(tx, k))[0]?.["status"] ?? "archived").toBe("archived");
      // 99 left: alert, in the same transaction as the ledger entry
      await tx`INSERT INTO public.id_credit_ledger (kind, credits, reserved_delta, note) VALUES ('adjustment', -1, 0, 'test')`;
      const [row] = await alertRow(tx, k);
      expect(row).toMatchObject({ status: "published", kind: "alert", min_role: "budtender" });
      expect(row!["body"]).toMatch(/^99 credits left \(about 33 checks\)/);
      // a reserve change counts too
      await tx`INSERT INTO public.id_credit_ledger (kind, credits, reserved_delta, note) VALUES ('reserve', 0, 60, 'test')`;
      expect((await alertRow(tx, k))[0]!["body"]).toMatch(/^39 credits left/);
      // top up: cleared
      await tx`INSERT INTO public.id_credit_ledger (kind, credits, note) VALUES ('top_up', 500, 'test')`;
      expect((await alertRow(tx, k))[0]!["status"]).toBe("archived");
      // raising the threshold above the balance brings it back
      await tx`UPDATE public.id_credit_settings SET low_balance_threshold = 1000 WHERE id`;
      expect((await alertRow(tx, k))[0]!["status"]).toBe("published");
    });
  });

  it("billing_record_payment keeps the provider and currency, so PayPal dollars are not logged as Payfast rand", async () => {
    const id = `pp-${key("p")}`.slice(0, 60);
    const before = (await queued("staff_billing_payment")).length;
    expect(
      (
        await rpc(
          sql,
          "billing_record_payment",
          "shopify-admin-api",
          "paypal",
          id,
          "COMPLETED",
          2500,
          "USD",
          "x",
        )
      ).recorded,
    ).toBe(true);
    const row = (
      await sql`SELECT provider, currency, amount_cents FROM public.billing_payments WHERE provider_payment_id = ${id}`
    )[0]!;
    expect(row).toMatchObject({ provider: "paypal", currency: "USD", amount_cents: 2500 });
    expect(
      (
        await rpc(
          sql,
          "billing_record_payment",
          "shopify-admin-api",
          "paypal",
          id,
          "COMPLETED",
          2500,
          "USD",
          "x",
        )
      ).recorded,
    ).toBe(false);
    const mail = await queued("staff_billing_payment");
    expect(mail.length - before).toBe(1);
    expect(mail.at(-1)!["data"]).toMatchObject({ currency: "USD", amount_cents: 2500 });
    for (const [prov, cur] of [
      ["stripe", "USD"],
      ["paypal", "usd"],
    ] as const)
      expect(
        failedWith(
          await attempt(
            rpc(
              sql,
              "billing_record_payment",
              "shopify-admin-api",
              prov,
              "z1",
              "COMPLETED",
              1,
              cur,
              null,
            ),
          ),
          "invalid_input",
        ),
      ).toBe(true);
  });

  it("PayPal sales are logged only for our subscription; refunds only for a payment already logged; subscription events update and notify", async () => {
    const sub = `I-${key("s")
      .replace(/[^A-Z0-9]/gi, "")
      .toUpperCase()}`.slice(0, 20);
    const sale = `SALE${key("x")
      .replace(/[^A-Z0-9]/gi, "")
      .toUpperCase()}`.slice(0, 20);
    expect(
      (await rpc(sql, "billing_paypal_sale", "COMPLETED", sub, sale, "", 2500, "USD")).reason,
    ).toBe("unknown_subscription");
    await sql`INSERT INTO public.admin_api_subscriptions (paypal_subscription_id, billing_interval, paypal_plan_id, status)
              VALUES (${sub}, 'monthly', 'P-1', 'ACTIVE')`;
    expect(
      (await rpc(sql, "billing_paypal_sale", "COMPLETED", sub, sale, "", 2500, "USD")).recorded,
    ).toBe(true);
    expect(
      (await rpc(sql, "billing_paypal_sale", "COMPLETED", sub, sale, "", 2500, "USD")).recorded,
    ).toBe(false);
    const hist =
      await sql`SELECT a.slug, p.provider, p.currency FROM public.billing_payments p JOIN public.billing_accounts a ON a.id = p.account_id WHERE p.provider_payment_id = ${sale}`;
    expect(hist[0]).toMatchObject({
      slug: "shopify-admin-api",
      provider: "paypal",
      currency: "USD",
    });
    // refund of an unknown sale is ignored; of a logged sale it is recorded
    expect(
      (await rpc(sql, "billing_paypal_sale", "REFUNDED", "", `RF-${sale}`, "NOPE", 2500, "USD"))
        .reason,
    ).toBe("unknown_payment");
    expect(
      (await rpc(sql, "billing_paypal_sale", "REFUNDED", "", `RF-${sale}`, sale, 2500, "USD"))
        .recorded,
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "billing_paypal_sale", "DENIED", sub, "q1", "", 1, "USD")),
        "invalid_input",
      ),
    ).toBe(true);

    const before = (await queued("staff_billing_change")).length;
    const ev = key("evt");
    expect(
      (await rpc(sql, "billing_paypal_subscription_event", sub, "CANCELLED", ev)).recorded,
    ).toBe(true);
    expect(
      (
        await sql`SELECT status FROM public.admin_api_subscriptions WHERE paypal_subscription_id = ${sub}`
      )[0]!["status"],
    ).toBe("CANCELLED");
    await rpc(sql, "billing_paypal_subscription_event", sub, "CANCELLED", ev); // redelivery: no second email
    const mail = (await queued("staff_billing_change")).slice(before);
    expect(mail).toHaveLength(1);
    expect(mail[0]!["recipient"]).toBe("webmaster@cannaplug012.co.za");
    expect(mail[0]!["data"]).toMatchObject({ to: "cancelled", actor_name: "PayPal" });
    expect(
      (await rpc(sql, "billing_paypal_subscription_event", "I-UNKNOWN0000", "CANCELLED", key("e")))
        .reason,
    ).toBe("unknown_subscription");
    await rpc(sql, "billing_paypal_subscription_event", sub, "PAYMENT_FAILED", key("e"));
    expect(
      (
        await sql`SELECT status FROM public.admin_api_subscriptions WHERE paypal_subscription_id = ${sub}`
      )[0]!["status"],
    ).toBe("CANCELLED");
  });

  it("the new functions are service-role only; the manage-button account has no payment link", async () => {
    for (const q of [
      (tx: Sql) => tx`SELECT public.billing_due_alerts_refresh()`,
      (tx: Sql) => tx`SELECT public.team_alert_id_credits()`,
      (tx: Sql) => tx`SELECT public.billing_paypal_sale('COMPLETED', 'I-X', 'S', '', 1, 'USD')`,
      (tx: Sql) => tx`SELECT public.billing_paypal_subscription_event('I-X', 'CANCELLED', 'e1')`,
      (tx: Sql) =>
        tx`SELECT public.billing_record_payment('whatsapp', 'paypal', 'S', 'COMPLETED', 1, 'USD', null)`,
    ])
      expect((await attempt(asUser(sql, manager, q))).ok).toBe(false);
    const admin = await mkUser(sql, "admin");
    expect(
      failedWith(
        await attempt(
          rpc(
            sql,
            "billing_set_payment_link",
            admin,
            "godaddy-domain",
            "https://payf.st/abc",
            key("l"),
          ),
        ),
        "invalid_input",
      ),
    ).toBe(true);
    // the alert rows are staff-only through RLS: a budtender sees alerts at or below their role, never manager reminders
    await inRollback(async (tx) => {
      const today = (
        await tx`SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS d`
      )[0]!["d"];
      await tx`UPDATE public.billing_accounts SET anchor_date = ${today}::date + 1 WHERE slug = 'shopify-admin-api'`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claim.sub', ${budtender}, true)`;
      const seen =
        await tx`SELECT source_key FROM public.team_notifications WHERE source_key = 'alert:bill-due:shopify-admin-api'`;
      expect(seen).toHaveLength(0);
    });
  });

  it("mutation check: granting execute to browser roles would let them raise or fake billing events", async () => {
    const granted = await inRollback(async (tx) => {
      await tx`GRANT EXECUTE ON FUNCTION public.billing_paypal_subscription_event(text, text, text) TO authenticated`;
      await tx`SET LOCAL ROLE authenticated`;
      return (
        await attempt(
          tx`SELECT public.billing_paypal_subscription_event('I-NOPE', 'CANCELLED', 'mutation-1')`,
        )
      ).ok;
    });
    expect(granted).toBe(true);
    expect(
      (
        await attempt(
          asUser(
            sql,
            manager,
            (tx) =>
              tx`SELECT public.billing_paypal_subscription_event('I-NOPE', 'CANCELLED', 'mutation-2')`,
          ),
        )
      ).ok,
    ).toBe(false);
  });
});
