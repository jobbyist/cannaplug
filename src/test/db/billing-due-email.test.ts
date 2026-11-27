import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, connect, mkUser, type Sql } from "./helpers";

describe.skipIf(!DB_URL)("bill-due email to managers and admins (real PostgreSQL)", () => {
  let sql: Sql;
  const rolledBack = Symbol("rollback");
  /** Runs fn in a transaction that is always rolled back, so users, accounts and the queue are untouched. */
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
  const sastToday = async (tx: Sql): Promise<string> =>
    (await tx`SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS d`)[0]!["d"];
  const mail = (tx: Sql, ids: string[]) =>
    tx`SELECT recipient, data, dedupe_key, category
         FROM public.notification_events
        WHERE template = 'staff_billing_due' AND recipient_user_id = ANY(${ids}::uuid[])
        ORDER BY recipient`;
  const dueTomorrow = (tx: Sql, slug: string, today: string) =>
    tx`UPDATE public.billing_accounts SET anchor_date = ${today}::date + 1 WHERE slug = ${slug}`;

  beforeAll(async () => {
    sql = connect(10);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("emails each manager and admin once when a bill is due tomorrow, and never a budtender or customer", async () => {
    await inRollback(async (tx) => {
      const [manager, admin, budtender, customer] = await Promise.all([
        mkUser(tx, "manager"),
        mkUser(tx, "admin"),
        mkUser(tx, "budtender"),
        mkUser(tx, "customer"),
      ]);
      const everyone = [manager, admin, budtender, customer];
      const today = await sastToday(tx);
      // Shopify is due tomorrow; Payfast (monthly, 27th) is the next bill after it.
      await dueTomorrow(tx, "shopify-admin-api", today);
      await tx`SELECT public.billing_due_alerts_refresh()`;
      const rows = await mail(tx, everyone);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r["recipient"]).sort()).toEqual(
        [`admin-${admin}@test.local`, `manager-${manager}@test.local`].sort(),
      );
      for (const r of rows) {
        expect(r["category"]).toBe("staff");
        expect(r["data"]).toMatchObject({
          account: "Admin/Checkout API Integration (POS + E-Commerce)",
          provider: "Shopify",
        });
        expect(r["data"]["amount_text"]).toMatch(/^\$28\.75/);
        expect(r["data"]["due_on"]).toMatch(/^\w+, \d{1,2} \w+ \d{4}$/);
        expect(r["data"]["next_account"]).toBe("Online Payment Gateway Aggregator");
        expect(r["data"]["next_provider"]).toBe("Payfast");
        expect(r["dedupe_key"]).toMatch(/^billing_due:shopify-admin-api:\d{4}-\d{2}-\d{2}:/);
      }
      // no personal data in the payload
      expect(JSON.stringify(rows.map((r) => r["data"]))).not.toMatch(/@|user_id/);
    });
  });

  it("sends once per bill per due date: the 10-minute refresh never repeats it", async () => {
    await inRollback(async (tx) => {
      const manager = await mkUser(tx, "manager");
      const today = await sastToday(tx);
      await dueTomorrow(tx, "shopify-admin-api", today);
      await tx`SELECT public.billing_due_alerts_refresh()`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      expect(await mail(tx, [manager])).toHaveLength(1);
    });
  });

  it("sends nothing two days out, and nothing for a paused or cancelled account", async () => {
    await inRollback(async (tx) => {
      const manager = await mkUser(tx, "manager");
      const today = await sastToday(tx);
      await tx`UPDATE public.billing_accounts SET anchor_date = ${today}::date + 2 WHERE slug = 'shopify-admin-api'`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      expect(await mail(tx, [manager])).toHaveLength(0);
      for (const status of ["paused", "cancelled"]) {
        await dueTomorrow(tx, "shopify-admin-api", today);
        await tx`UPDATE public.billing_accounts SET status = ${status} WHERE slug = 'shopify-admin-api'`;
        await tx`SELECT public.billing_due_alerts_refresh()`;
        expect(await mail(tx, [manager])).toHaveLength(0);
      }
    });
  });

  it("the next bill skips paused accounts, and falls back to the account's own next cycle", async () => {
    await inRollback(async (tx) => {
      const manager = await mkUser(tx, "manager");
      const today = await sastToday(tx);
      await dueTomorrow(tx, "shopify-admin-api", today);
      await tx`UPDATE public.billing_accounts SET status = 'paused' WHERE slug = 'payfast-gateway'`;
      await tx`SELECT public.billing_due_alerts_refresh()`;
      const [row] = await mail(tx, [manager]);
      // Payfast is paused, so the next bill is Shopify's own cycle 30 days on (the domain is not due until 2027).
      expect(row!["data"]["next_account"]).toBe(
        "Admin/Checkout API Integration (POS + E-Commerce)",
      );
      const expected = (
        await tx`SELECT trim(to_char(${today}::date + 31, 'FMDay, FMDD FMMonth YYYY')) AS d`
      )[0]!["d"];
      expect(row!["data"]["next_due_on"]).toBe(expected);
    });
  });

  it("the refresh stays executable by service_role only", async () => {
    const rows =
      await sql`SELECT has_function_privilege('service_role', 'public.billing_due_alerts_refresh()', 'EXECUTE') AS s,
                                  has_function_privilege('authenticated', 'public.billing_due_alerts_refresh()', 'EXECUTE') AS a,
                                  has_function_privilege('anon', 'public.billing_due_alerts_refresh()', 'EXECUTE') AS n`;
    expect(rows[0]).toMatchObject({ s: true, a: false, n: false });
  });
});
