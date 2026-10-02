import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  failedWith,
  mkMember,
  rpc,
  uid,
  val,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("public website forms (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(10)));
  afterAll(async () => void (await sql.end()));
  const INBOX = "info@cannaplug012.co.za";
  const contact = (ip: string, over: Record<string, string> = {}) =>
    rpc(
      sql,
      "contact_submit",
      over["name"] ?? "Ada Lovelace",
      over["email"] ?? `ada-${uid()}@example.com`,
      over["subject"] ?? "Hello",
      over["message"] ?? "I would like to know more.",
      ip,
      INBOX,
    );

  it("stores the message and queues one email to the team inbox and one acknowledgement to the sender", async () => {
    const email = `sender-${uid()}@example.com`;
    const r = await contact(`ip-${uid()}`, { email });
    const rows =
      await sql`SELECT recipient, template, category, status FROM public.notification_events WHERE dedupe_key LIKE ${"contact:" + r.id + ":%"} ORDER BY template`;
    expect(rows.map((x) => [x["recipient"], x["template"], x["category"], x["status"]])).toEqual([
      [email, "contact_form_ack", "transactional", "queued"],
      [INBOX, "contact_form_staff", "staff", "queued"],
    ]);
    expect(
      await val(sql`SELECT count(*)::int FROM public.contact_submissions WHERE id = ${r.id}`),
    ).toBe(1);
  });

  it("rejects bad input and rate-limits one address to 5 messages an hour", async () => {
    for (const bad of [
      { name: "A" },
      { email: "not-an-email" },
      { subject: "" },
      { message: "hi" },
    ])
      expect((await attempt(contact(`ip-${uid()}`, bad))).ok, JSON.stringify(bad)).toBe(false);
    expect(
      (
        await attempt(
          rpc(sql, "contact_submit", "Ada", "a@example.com", "Hello", "A message", "ip", "nope"),
        )
      ).ok,
    ).toBe(false);
    const ip = `flood-${uid()}`;
    for (let i = 0; i < 5; i++) await contact(ip);
    expect(failedWith(await attempt(contact(ip)), "rate_limited")).toBe(true);
    expect((await attempt(contact(`other-${uid()}`))).ok).toBe(true);
  });

  it("newsletter: explicit consent recorded, welcome queued once, duplicates silent, unsubscribe and resubscribe work", async () => {
    const email = `News-${uid()}@Example.com`;
    expect(await rpc(sql, "newsletter_subscribe", email, `ip-${uid()}`, "website_footer")).toEqual({
      status: "subscribed",
    });
    expect(
      await rpc(sql, "newsletter_subscribe", email.toLowerCase(), `ip-${uid()}`, "website_footer"),
    ).toEqual({ status: "subscribed" });
    const [sub] =
      await sql`SELECT id, unsubscribe_token, consent_at, unsubscribed_at FROM public.newsletter_subscribers WHERE lower(email) = ${email.toLowerCase()}`;
    expect(sub!["consent_at"]).toBeTruthy();
    expect(sub!["unsubscribe_token"]).toMatch(/^[0-9a-f]{48}$/);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.notification_events WHERE template = 'newsletter_welcome' AND recipient = ${email}`,
      ),
    ).toBe(1);

    await rpc(sql, "newsletter_unsubscribe", sub!["unsubscribe_token"]);
    expect(
      await val(
        sql`SELECT unsubscribed_at IS NOT NULL FROM public.newsletter_subscribers WHERE id = ${sub!["id"]}`,
      ),
    ).toBe(true);
    await rpc(sql, "newsletter_unsubscribe", sub!["unsubscribe_token"]); // idempotent
    await rpc(sql, "newsletter_subscribe", email, `ip-${uid()}`, "website_footer"); // coming back re-consents
    expect(
      await val(
        sql`SELECT unsubscribed_at IS NULL FROM public.newsletter_subscribers WHERE id = ${sub!["id"]}`,
      ),
    ).toBe(true);
    expect(
      failedWith(await attempt(rpc(sql, "newsletter_unsubscribe", "short")), "invalid_token"),
    ).toBe(true);
    expect(
      failedWith(
        await attempt(rpc(sql, "newsletter_subscribe", "nope", null, "x")),
        "invalid_email",
      ),
    ).toBe(true);
  });

  it("clients cannot call the RPCs or read the stored messages and subscribers", async () => {
    const member = await mkMember(sql);
    for (const run of [
      (t: (tx: Sql) => Promise<unknown>) => asUser(sql, member, t),
      (t: (tx: Sql) => Promise<unknown>) => asAnon(sql, t),
    ]) {
      for (const q of [
        (tx: Sql) =>
          tx`SELECT public.contact_submit('Ada', 'a@example.com', 'Hi', 'A message', 'ip', 'x@example.com')`,
        (tx: Sql) => tx`SELECT public.newsletter_subscribe('a@example.com', 'ip', 'x')`,
        (tx: Sql) => tx`SELECT public.newsletter_unsubscribe('${"0".repeat(48)}')`,
        (tx: Sql) => tx`SELECT * FROM public.contact_submissions`,
        (tx: Sql) => tx`SELECT * FROM public.newsletter_subscribers`,
      ])
        expect((await attempt(run(async (tx) => q(tx)))).ok).toBe(false);
    }
  });
});
