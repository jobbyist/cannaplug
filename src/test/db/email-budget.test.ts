import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DB_URL, connect, type Sql } from "./helpers";

/**
 * Resend daily budget: the dispatcher only claims emails while the last 24 hours stay under budget, highest
 * priority first. Every scenario runs inside one transaction that is rolled back, with a small budget, so it
 * neither sees nor disturbs the emails other test files are queueing at the same time.
 */
describe.skipIf(!DB_URL)("email daily budget (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(5)));
  afterAll(async () => void (await sql.end()));

  class Rollback extends Error {}
  async function scenario<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await sql
      .begin(async (tx) => {
        const t = tx as unknown as Sql;
        // A tiny budget: 10 a day, 1 kept for Supabase, digests up to 6, campaigns up to 3.
        await t`UPDATE public.email_budget_settings
                SET daily_limit = 10, reserved_for_auth = 1, normal_ceiling = 6, low_ceiling = 3`;
        // Park everything else that is waiting, so only this scenario's emails are due.
        await t`UPDATE public.notification_events SET status = 'suppressed' WHERE status IN ('queued', 'failed', 'sending')`;
        // Start from an empty 24-hour window.
        await t`UPDATE public.notification_events SET sent_at = now() - interval '2 days' WHERE status = 'sent'`;
        await t`UPDATE public.pos_receipt_sends SET created_at = now() - interval '2 days'`.catch(
          () => undefined,
        );
        out = await fn(t);
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    return out as T;
  }
  const enqueue = (tx: Sql, template: string, n: number, category = "transactional") =>
    tx`INSERT INTO public.notification_events (channel, category, template, recipient, data, dedupe_key)
       SELECT 'email', ${category}, ${template}, 'x' || g || '@example.com',
              ${category === "marketing" ? sql.json({ consent: true }) : sql.json({})},
              ${template} || ':' || gen_random_uuid()
       FROM generate_series(1, ${n}) g`;
  const sent = (tx: Sql, n: number) =>
    tx`INSERT INTO public.notification_events (channel, template, recipient, dedupe_key, status, sent_at)
       SELECT 'email', 'order_confirmed', 'sent@example.com', 'sent:' || gen_random_uuid(), 'sent', now() - interval '1 hour'
       FROM generate_series(1, ${n}) g`;
  const claim = async (tx: Sql) =>
    (await tx`SELECT template FROM public.notification_claim(100)`).map(
      (r) => r["template"] as string,
    );

  it("hands out high-priority email first and stops at the daily budget, keeping room for Supabase", async () => {
    const got = await scenario(async (tx) => {
      await enqueue(tx, "promo_announcement", 5, "marketing");
      await enqueue(tx, "staff_low_stock", 5, "staff");
      await enqueue(tx, "order_confirmed", 12);
      return claim(tx);
    });
    // 9 usable (10 - 1 reserved): all 9 go to order emails; digests and campaigns wait.
    expect(got).toHaveLength(9);
    expect(new Set(got)).toEqual(new Set(["order_confirmed"]));
  });

  it("digests and campaigns use only their share; the rest of the day stays free for important email", async () => {
    const got = await scenario(async (tx) => {
      await sent(tx, 2);
      await enqueue(tx, "promo_announcement", 5, "marketing");
      await enqueue(tx, "staff_low_stock", 5, "staff");
      await enqueue(tx, "order_ready", 1);
      return claim(tx);
    });
    // used 2: order_ready -> 3; low stock up to 6 -> 3 more; campaigns stop at 3 -> none.
    expect(got.filter((t) => t === "order_ready")).toHaveLength(1);
    expect(got.filter((t) => t === "staff_low_stock")).toHaveLength(3);
    expect(got.filter((t) => t === "promo_announcement")).toHaveLength(0);
  });

  it("emails over budget wait in the queue (not lost); other channels are not limited", async () => {
    const left = await scenario(async (tx) => {
      await sent(tx, 9);
      await enqueue(tx, "order_confirmed", 2);
      await tx`INSERT INTO public.notification_events (channel, template, recipient, dedupe_key)
               VALUES ('sms', 'order_ready', '+27820000000', 'sms:' || gen_random_uuid())`;
      const got = await claim(tx);
      expect(got).toEqual(["order_ready"]); // the SMS
      return (
        await tx`SELECT count(*)::int AS n FROM public.notification_events WHERE channel = 'email' AND status = 'queued'`
      )[0]!["n"];
    });
    expect(left).toBe(2);
  });

  it("ID-review and ID-received emails are never sent; receipts count toward the budget", async () => {
    const out = await scenario(async (tx) => {
      await enqueue(tx, "staff_id_review", 2, "staff");
      await enqueue(tx, "id_submitted", 1);
      const got = await claim(tx);
      const suppressed = (
        await tx`SELECT count(*)::int AS n FROM public.notification_events
                 WHERE template IN ('staff_id_review', 'id_submitted') AND status = 'suppressed'
                   AND created_at > now() - interval '1 minute'`
      )[0]!["n"];
      await sent(tx, 9);
      const status = (await tx`SELECT public.email_budget_status() AS s`)[0]!["s"];
      return { got, suppressed, status };
    });
    expect(out.got).toEqual([]);
    expect(out.suppressed).toBeGreaterThanOrEqual(3);
    expect(out.status).toMatchObject({ used: 9, limit: 10, usable: 9, receipts_open: false });
  });
});
