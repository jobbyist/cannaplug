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
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("billing accounts (real PostgreSQL)", () => {
  let sql: Sql;
  let admin: string;
  let manager: string;
  let budtender: string;
  let member: string;
  const status = async (slug: string) =>
    (await sql`SELECT status FROM public.billing_accounts WHERE slug = ${slug}`)[0]?.["status"];
  const setStatus = (
    actor: string,
    slug: string,
    to: string,
    reason: string | null = null,
    k = key("b"),
  ) => rpc(sql, "billing_set_status", actor, slug, to, reason, k);
  const setLink = (actor: string, slug: string, url: string | null, k = key("l")) =>
    rpc(sql, "billing_set_payment_link", actor, slug, url, k);
  const queued = (template: string) =>
    sql`SELECT recipient, data FROM public.notification_events WHERE template = ${template}`;

  beforeAll(async () => {
    sql = connect(10);
    [admin, manager, budtender, member] = await Promise.all([
      mkUser(sql, "admin"),
      mkUser(sql, "manager"),
      mkUser(sql, "budtender"),
      mkUser(sql, "customer"),
    ]);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("seeds the schedule's six accounts with the supplied payment links", async () => {
    const rows =
      await sql`SELECT slug, status, payment_kind, payment_url FROM public.billing_accounts ORDER BY position`;
    expect(rows.map((r) => r["slug"])).toEqual([
      "shopify-admin-api",
      "clinical-documents",
      "email-push",
      "whatsapp",
      "payfast-gateway",
      "verifynow-id",
    ]);
    const by = (s: string) => rows.find((r) => r["slug"] === s)!;
    expect(by("payfast-gateway")).toMatchObject({
      payment_kind: "link",
      payment_url: "https://payf.st/rl53i",
    });
    expect(by("verifynow-id")).toMatchObject({ payment_kind: "payfast_form", payment_url: null });
    expect(by("clinical-documents")!["status"]).toBe("pending");
  });

  it("budtenders and members cannot change an account; managers and admins can", async () => {
    for (const who of [budtender, member]) {
      expect(
        failedWith(await attempt(setStatus(who, "shopify-admin-api", "paused")), "forbidden"),
      ).toBe(true);
    }
    expect(
      failedWith(
        await attempt(setStatus(null as unknown as string, "shopify-admin-api", "paused")),
        "forbidden",
      ),
    ).toBe(true);
    expect((await setStatus(manager, "shopify-admin-api", "paused", "testing")).changed).toBe(true);
    expect(await status("shopify-admin-api")).toBe("paused");
    expect((await setStatus(admin, "shopify-admin-api", "active")).previous).toBe("paused");
  });

  it("pause, cancel and resume are audited and each change emails both developer addresses", async () => {
    const before = (await queued("staff_billing_change")).length;
    const k = key("b");
    const r = await setStatus(manager, "payfast-gateway", "cancelled", "Switching aggregator", k);
    expect(r).toMatchObject({ changed: true, status: "cancelled", previous: "active" });
    const audit =
      await sql`SELECT metadata FROM public.audit_log WHERE action = 'billing_status_changed' AND actor_user_id = ${manager} ORDER BY id DESC LIMIT 1`;
    expect(audit[0]!["metadata"]).toMatchObject({
      slug: "payfast-gateway",
      from: "active",
      to: "cancelled",
      reason: "Switching aggregator",
    });
    const rows = await queued("staff_billing_change");
    expect(rows.length - before).toBe(2);
    expect(rows.map((x) => x["recipient"])).toEqual(
      expect.arrayContaining(["webmaster@cannaplug012.co.za", "primelifer@gmail.com"]),
    );
    // replay does not double-send or double-audit
    expect(
      (await setStatus(manager, "payfast-gateway", "cancelled", "Switching aggregator", k))
        .replayed,
    ).toBe(true);
    expect((await queued("staff_billing_change")).length - before).toBe(2);
    await setStatus(admin, "payfast-gateway", "active");
  });

  it("validates input, refuses pending accounts, and rejects a reused key with a different request", async () => {
    expect(
      failedWith(
        await attempt(setStatus(manager, "shopify-admin-api", "deleted")),
        "invalid_input",
      ),
    ).toBe(true);
    expect(
      failedWith(await attempt(setStatus(manager, "whatsapp", "paused")), "invalid_input"),
    ).toBe(true);
    expect(
      failedWith(await attempt(setStatus(manager, "nope", "paused")), "billing_account_not_found"),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(setStatus(manager, "email-push", "paused", "x".repeat(301))),
        "invalid_input",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(setStatus(manager, "email-push", "paused", null, "short")),
        "idempotency_key_required",
      ),
    ).toBe(true);
    const k = key("b");
    await setStatus(manager, "email-push", "paused", null, k);
    expect(
      failedWith(
        await attempt(setStatus(manager, "email-push", "cancelled", null, k)),
        "idempotency_conflict",
      ),
    ).toBe(true);
    await setStatus(manager, "email-push", "active");
  });

  it("only admins set payment links, and only https links on known payment hosts", async () => {
    expect(
      failedWith(
        await attempt(setLink(manager, "whatsapp", "https://paypal.me/cannaplug")),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(setLink(admin, "whatsapp", "http://paypal.me/cannaplug")),
        "invalid_input",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(setLink(admin, "whatsapp", "https://evil.example.com/pay")),
        "invalid_input",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(setLink(admin, "whatsapp", "https://paypal.me.evil.com/x")),
        "invalid_input",
      ),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(setLink(admin, "verifynow-id", "https://payf.st/abc")),
        "invalid_input",
      ),
    ).toBe(true);
    expect((await setLink(admin, "whatsapp", "https://paypal.me/cannaplug")).changed).toBe(true);
    expect(
      (
        await sql`SELECT payment_kind, payment_url FROM public.billing_accounts WHERE slug = 'whatsapp'`
      )[0],
    ).toMatchObject({
      payment_kind: "link",
      payment_url: "https://paypal.me/cannaplug",
    });
    await setLink(admin, "whatsapp", null);
    expect(
      (await sql`SELECT payment_kind FROM public.billing_accounts WHERE slug = 'whatsapp'`)[0]![
        "payment_kind"
      ],
    ).toBe("none");
  });

  it("records a Payfast payment once per payment id and status, and emails the developer only on COMPLETE", async () => {
    const id = `pf-${key("p")}`.slice(0, 60);
    const before = (await queued("staff_billing_payment")).length;
    const first = await rpc(
      sql,
      "billing_record_payment",
      "verifynow-id",
      id,
      "COMPLETE",
      10000,
      "Real-Time ID Verification API Credits",
    );
    expect(first.recorded).toBe(true);
    expect(
      (await rpc(sql, "billing_record_payment", "verifynow-id", id, "COMPLETE", 10000, null))
        .recorded,
    ).toBe(false);
    const mail = await queued("staff_billing_payment");
    expect(mail.length - before).toBe(1);
    expect(mail.at(-1)!["recipient"]).toBe("webmaster@cannaplug012.co.za");
    await rpc(sql, "billing_record_payment", "verifynow-id", `${id}x`, "CANCELLED", 500, null);
    expect((await queued("staff_billing_payment")).length - before).toBe(1);
    expect(
      failedWith(
        await attempt(rpc(sql, "billing_record_payment", "nope", id, "COMPLETE", 1, null)),
        "billing_account_not_found",
      ),
    ).toBe(true);
  });

  it("browser roles can read as manager+ only and can never write or call the functions", async () => {
    expect(
      (await asUser(sql, manager, (tx) => tx`SELECT id FROM public.billing_accounts`)).length,
    ).toBe(6);
    expect(
      (await asUser(sql, budtender, (tx) => tx`SELECT id FROM public.billing_accounts`)).length,
    ).toBe(0);
    expect(
      (await asUser(sql, member, (tx) => tx`SELECT id FROM public.billing_payments`)).length,
    ).toBe(0);
    expect(
      (await asAnon(sql, (tx) => tx`SELECT id FROM public.billing_accounts`).catch(() => []))
        .length,
    ).toBe(0);
    for (const who of [admin, manager]) {
      expect(
        (
          await attempt(
            asUser(sql, who, (tx) => tx`UPDATE public.billing_accounts SET status = 'cancelled'`),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            asUser(
              sql,
              who,
              (tx) =>
                tx`SELECT public.billing_set_status(${who}, 'email-push', 'paused', null, 'browser-key-1')`,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await attempt(
            asUser(
              sql,
              who,
              (tx) =>
                tx`SELECT public.billing_record_payment('verifynow-id', 'x1', 'COMPLETE', 1, null)`,
            ),
          )
        ).ok,
      ).toBe(false);
    }
    expect(await status("email-push")).toBe("active");
  });

  it("mutation check: weakening each new rule makes the matching attack succeed", async () => {
    const rolledBack = Symbol("rollback");
    const inRollback = async (fn: (tx: Sql) => Promise<unknown>) => {
      let out: unknown;
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
    // 1. Browser roles may not run the status function.
    const granted = await inRollback(async (tx) => {
      await tx`GRANT EXECUTE ON FUNCTION public.billing_set_status(uuid, text, text, text, text) TO authenticated`;
      await tx`SET LOCAL ROLE authenticated`;
      return (
        await attempt(
          tx`SELECT public.billing_set_status(${manager}, 'email-push', 'paused', null, 'mutation-key-1')`,
        )
      ).ok;
    });
    expect(granted).toBe(true);
    // 2. Payment history is visible to managers only because of RLS.
    await rpc(
      sql,
      "billing_record_payment",
      "verifynow-id",
      key("m").slice(0, 60),
      "COMPLETE",
      1,
      null,
    );
    const leaked = await inRollback(async (tx) => {
      await tx`DROP POLICY "managers read billing payments" ON public.billing_payments`;
      await tx`CREATE POLICY "broad" ON public.billing_payments FOR SELECT TO authenticated USING (true)`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claim.sub', ${member}, true)`;
      return (await tx`SELECT id FROM public.billing_payments`).length;
    });
    expect(leaked).toBeGreaterThan(0);
    expect(
      (await asUser(sql, member, (tx) => tx`SELECT id FROM public.billing_payments`)).length,
    ).toBe(0);
    // 3. With RLS off, a budtender could read the accounts.
    const exposed = await inRollback(async (tx) => {
      await tx`ALTER TABLE public.billing_accounts DISABLE ROW LEVEL SECURITY`;
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT set_config('request.jwt.claim.sub', ${budtender}, true)`;
      return (await tx`SELECT id FROM public.billing_accounts`).length;
    });
    expect(exposed).toBe(6);
    expect(
      (await asUser(sql, budtender, (tx) => tx`SELECT id FROM public.billing_accounts`)).length,
    ).toBe(0);
  });
});
