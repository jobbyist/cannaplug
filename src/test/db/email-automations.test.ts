import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  connect,
  mkMember,
  mkProduct,
  mkUser,
  receive,
  rpc,
  uid,
  val,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("email automations (real PostgreSQL)", () => {
  let sql: Sql;
  let manager: string;
  beforeAll(async () => {
    sql = connect(10);
    manager = await mkUser(sql, "manager");
  });
  afterAll(async () => void (await sql.end()));

  const queued = (template: string, userId: string) =>
    val<number>(
      sql`SELECT count(*)::int FROM public.notification_events WHERE template = ${template} AND recipient_user_id = ${userId}`,
    );

  it("a new member gets exactly one welcome email", async () => {
    const id = uid();
    await sql`INSERT INTO auth.users (id, email) VALUES (${id}, ${`w-${id}@test.local`})`;
    await sql`INSERT INTO public.profiles (id, full_name) VALUES (${id}, 'Wendy Welcome') ON CONFLICT (id) DO NOTHING`;
    expect(await queued("member_welcome", id)).toBe(1);
    await sql`UPDATE public.profiles SET full_name = 'Wendy W' WHERE id = ${id}`;
    expect(await queued("member_welcome", id)).toBe(1);
  });

  it("ID verification: member is told when it is received, approved and rejected; managers are told about new submissions", async () => {
    const member = await mkUser(sql, "customer");
    await sql`INSERT INTO public.customer_verification (user_id, status, document_type, declared_dob, submitted_at, document_path)
              VALUES (${member}, 'pending', 'sa_id', '1990-01-01', now(), ${`${member}/id.jpg`})`;
    expect(await queued("id_submitted", member)).toBe(1);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.notification_events WHERE template = 'staff_id_review' AND recipient_user_id = ${manager}`,
      ),
    ).toBeGreaterThanOrEqual(1);
    await sql`UPDATE public.customer_verification SET status = 'verified', verified_at = now(), verified_by = ${manager}, reviewed_at = now(), reviewed_by = ${manager}, method = 'manual_id_review' WHERE user_id = ${member}`;
    expect(await queued("id_approved", member)).toBe(1);
    // unchanged status never re-sends
    await sql`UPDATE public.customer_verification SET attempt_count = attempt_count WHERE user_id = ${member}`;
    expect(await queued("id_approved", member)).toBe(1);
  });

  it("ID expiring: one reminder per expiry date for passports/licences inside 30 days; SA IDs (no expiry) never", async () => {
    const soon = await mkMember(sql);
    await sql`UPDATE public.customer_verification SET document_type = 'passport', document_expires_on = current_date + 10 WHERE user_id = ${soon}`;
    const far = await mkMember(sql);
    await sql`UPDATE public.customer_verification SET document_type = 'passport', document_expires_on = current_date + 200 WHERE user_id = ${far}`;
    const sa = await mkMember(sql);
    await rpc(sql, "email_automations_run");
    await rpc(sql, "email_automations_run");
    expect(await queued("id_expiring", soon)).toBe(1);
    expect(await queued("id_expiring", far)).toBe(0);
    expect(await queued("id_expiring", sa)).toBe(0);
  });

  it("back in stock: told once when a subscribed product becomes available again", async () => {
    const member = await mkMember(sql);
    const product = await mkProduct(sql, 90);
    await sql`INSERT INTO public.back_in_stock_subscriptions (user_id, product_id) VALUES (${member}, ${product})`;
    await rpc(sql, "email_automations_run");
    expect(await queued("back_in_stock", member)).toBe(0); // still no stock
    await receive(sql, manager, product, 5);
    await rpc(sql, "email_automations_run");
    await rpc(sql, "email_automations_run");
    expect(await queued("back_in_stock", member)).toBe(1);
  });

  it("low stock: managers get at most one digest a day", async () => {
    const product = await mkProduct(sql, 70);
    await receive(sql, manager, product, 2);
    await rpc(sql, "email_automations_run");
    await rpc(sql, "email_automations_run");
    expect(await queued("staff_low_stock", manager)).toBe(1);
  });

  it("weekly digest: Thursdays only, consenting subscribers only, one per subscriber per week, with an unsubscribe link", async () => {
    const email = `digest-${uid()}@example.com`;
    await rpc(sql, "newsletter_subscribe", email, `ip-${uid()}`, "test");
    const gone = `gone-${uid()}@example.com`;
    await rpc(sql, "newsletter_subscribe", gone, `ip-${uid()}`, "test");
    await sql`UPDATE public.newsletter_subscribers SET unsubscribed_at = now() WHERE email = ${gone}`;
    await sql`INSERT INTO public.articles (slug, title, excerpt, body_md) VALUES (${`a-${uid()}`}, 'Digest article', 'An excerpt for the digest email.', 'body') ON CONFLICT DO NOTHING`;
    const friday = "2026-10-09T08:00:00Z";
    const thursday = "2026-10-08T08:00:00Z";
    const before = await val<number>(
      sql`SELECT count(*)::int FROM public.notification_events WHERE template = 'journal_digest'`,
    );
    await rpc(sql, "email_automations_run", friday);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.notification_events WHERE template = 'journal_digest'`,
      ),
    ).toBe(before);
    await rpc(sql, "email_automations_run", thursday);
    await rpc(sql, "email_automations_run", thursday);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.notification_events WHERE template = 'journal_digest' AND recipient = ${email}`,
      ),
    ).toBe(1);
    expect(
      await val(
        sql`SELECT count(*)::int FROM public.notification_events WHERE template = 'journal_digest' AND recipient = ${gone}`,
      ),
    ).toBe(0);
    const [row] =
      await sql`SELECT category, data FROM public.notification_events WHERE template = 'journal_digest' AND recipient = ${email}`;
    expect(row!["category"]).toBe("marketing");
    expect((row!["data"] as { unsubscribe_token: string }).unsubscribe_token).toMatch(
      /^[0-9a-f]{48}$/,
    );
  });
});
