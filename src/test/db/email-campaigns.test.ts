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
  uid,
  val,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("email campaigns and member email preferences (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  let budtender: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
    budtender = await mkUser(sql, "budtender");
  });
  afterAll(async () => {
    await sql.end();
  });

  const save = (
    actor: string,
    over: Partial<
      Record<"id" | "subject" | "headline" | "body" | "label" | "url", string | null>
    > = {},
  ) =>
    rpc(
      sql,
      "email_campaign_save",
      actor,
      over.id ?? null,
      over.subject ?? "Spring specials",
      "Fresh drops this week",
      over.headline ?? "New in store",
      over.body ?? "Come and see what just arrived at the shop.",
      over.label === undefined ? "Shop now" : over.label,
      over.url === undefined ? "https://cannaplug012.co.za/shop" : over.url,
      key("save"),
    );

  it("only managers write campaigns, and a button needs a label and an https link", async () => {
    expect(failedWith(await attempt(save(budtender)), "forbidden")).toBe(true);
    expect(failedWith(await attempt(save(manager, { url: null })), "invalid_input")).toBe(true);
    expect((await attempt(save(manager, { url: "javascript:alert(1)" }))).ok).toBe(false);
    const c = await save(manager, { label: null, url: null });
    expect(c.status).toBe("draft");
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.audit_log WHERE action = 'email_campaign_saved' AND entity_id = ${c.id}`,
      ),
    ).toBe(1);
  });

  it("a test goes only to the manager; sending reaches consenting subscribers once, with their unsubscribe link", async () => {
    const tag = uid().slice(0, 8);
    const on = `on-${tag}@example.com`;
    const off = `off-${tag}@example.com`;
    await rpc(sql, "newsletter_subscribe", on, null, "test");
    await rpc(sql, "newsletter_subscribe", off, null, "test");
    await sql`UPDATE public.newsletter_subscribers SET unsubscribed_at = now() WHERE email = ${off}`;
    const c = await save(manager, { subject: `Campaign ${tag}` });

    const t = await rpc(sql, "email_campaign_test", manager, c.id, key("test"));
    const testRow = (
      await sql`SELECT recipient, category, data FROM public.notification_events
                               WHERE dedupe_key LIKE ${"campaign-test:" + c.id + ":%"}`
    )[0]!;
    expect(testRow["recipient"]).toBe(t.sent_to);
    expect(testRow["category"]).toBe("staff");

    const sent = await rpc(sql, "email_campaign_send", manager, c.id, key("send"));
    const rows =
      await sql`SELECT recipient, category, template, data FROM public.notification_events
                           WHERE dedupe_key LIKE ${"campaign:" + c.id + ":%"}`;
    const recipients = rows.map((r) => r["recipient"]);
    expect(recipients).toContain(on);
    expect(recipients).not.toContain(off);
    expect(sent.recipients).toBe(rows.length);
    const mine = rows.find((r) => r["recipient"] === on)!;
    expect(mine["category"]).toBe("marketing");
    expect(mine["template"]).toBe("promo_announcement");
    expect(mine["data"]).toMatchObject({
      consent: "true",
      subject: `Campaign ${tag}`,
      cta_url: "https://cannaplug012.co.za/shop",
    });
    expect(String((mine["data"] as Record<string, unknown>)["unsubscribe_token"])).toMatch(
      /^[0-9a-f]{48}$/,
    );

    expect(
      failedWith(
        await attempt(rpc(sql, "email_campaign_send", manager, c.id, key("again"))),
        "campaign_already_sent",
      ),
    ).toBe(true);
    expect(failedWith(await attempt(save(manager, { id: c.id })), "campaign_not_editable")).toBe(
      true,
    );
    expect(
      failedWith(
        await attempt(rpc(sql, "email_campaign_send", budtender, c.id, key("b"))),
        "forbidden",
      ),
    ).toBe(true);
    expect(
      await val(
        sql`SELECT (metadata->>'recipients')::int FROM public.audit_log WHERE action = 'email_campaign_sent' AND entity_id = ${c.id}`,
      ),
    ).toBe(rows.length);
  });

  it("a member opts in and out from their account; browsers cannot call any of it", async () => {
    const member = await mkUser(sql, "customer");
    expect(await rpc(sql, "member_newsletter_status", member)).toBe(false);
    await rpc(sql, "member_newsletter_set", member, true, key("on"));
    expect(await rpc(sql, "member_newsletter_status", member)).toBe(true);
    expect(
      await val(
        sql`SELECT consent_source FROM public.newsletter_subscribers WHERE email = ${`customer-${member}@test.local`}`,
      ),
    ).toBe("account_settings");
    await rpc(sql, "member_newsletter_set", member, false, key("off"));
    expect(await rpc(sql, "member_newsletter_status", member)).toBe(false);
    for (const call of [
      (tx: Sql) => tx`SELECT public.member_newsletter_set(${member}::uuid, true, 'abcdefgh1')`,
      (tx: Sql) => tx`SELECT * FROM public.email_campaigns`,
      (tx: Sql) =>
        tx`SELECT public.email_campaign_send(${member}::uuid, gen_random_uuid(), 'abcdefgh2')`,
    ])
      expect((await attempt(asUser(sql, member, call))).ok).toBe(false);
  });
});
