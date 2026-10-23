import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DB_URL,
  asAnon,
  asUser,
  attempt,
  connect,
  failedWith,
  key,
  mkMember,
  mkUser,
  rpc,
  uid,
  val,
  type Sql,
} from "./helpers";

describe.skipIf(!DB_URL)("web push channel (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => void (sql = connect(4)));
  afterAll(async () => void (await sql.end()));

  const P256 = "B".repeat(87);
  const AUTH = "A".repeat(22);
  const endpointFor = () => `https://fcm.googleapis.com/fcm/send/${uid()}`;
  const subscribe = (user: string, endpoint = endpointFor()) =>
    rpc(sql, "push_subscribe", user, endpoint, P256, AUTH, "Test browser", key("sub")).then(
      () => endpoint,
    );
  const setTopic = (user: string, topic: string, on: boolean) =>
    rpc(sql, "notification_set_preference", user, topic, on, key("pref"));
  const email = (user: string, template: string, category = "transactional", data: object = {}) => {
    const dedupe = `test:${uid()}`;
    return rpc(
      sql,
      "notification_enqueue",
      "email",
      template,
      "m@example.com",
      user,
      category,
      data,
      dedupe,
    ).then(() => dedupe);
  };
  const pushRow = async (dedupe: string) =>
    (await sql`SELECT * FROM public.notification_events WHERE dedupe_key = ${dedupe + ":push"}`)[0];

  it("a queued email to a member with a device also queues exactly one push (dedupe), same template", async () => {
    const m = await mkMember(sql);
    await subscribe(m);
    const d = await email(m, "order_ready", "transactional", { order_number: "CP-2610-0001" });
    const row = await pushRow(d);
    expect(row).toMatchObject({
      channel: "push",
      template: "order_ready",
      recipient: m,
      recipient_user_id: m,
    });
    expect(row!["data"]).toMatchObject({ push_topic: "orders", order_number: "CP-2610-0001" });
    // the same notification enqueued again (a replayed event) adds nothing
    await rpc(
      sql,
      "notification_enqueue",
      "email",
      "order_ready",
      "m@example.com",
      m,
      "transactional",
      {},
      d,
    );
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.notification_events WHERE dedupe_key LIKE ${d + "%"}`,
      ),
    ).toBe(2);
  });

  it("no device, a topic switched off, or an unmapped template → no push row", async () => {
    const lonely = await mkMember(sql);
    expect(await pushRow(await email(lonely, "order_ready"))).toBeUndefined();
    const m = await mkMember(sql);
    await subscribe(m);
    await setTopic(m, "orders", false);
    expect(await pushRow(await email(m, "order_confirmed"))).toBeUndefined();
    expect(await pushRow(await email(m, "member_welcome"))).toBeUndefined(); // not a push topic
    expect(await pushRow(await email(m, "back_in_stock"))).toBeDefined(); // other topics still on
  });

  it("marketing topics are opt-in; once opted in, the push carries consent and waits out quiet hours", async () => {
    const m = await mkMember(sql);
    await subscribe(m);
    const before = await email(m, "promo_announcement", "marketing", { consent: "true" });
    expect(await pushRow(before)).toBeUndefined(); // default off
    await setTopic(m, "promos", true);
    const after = await email(m, "promo_announcement", "marketing", { consent: "true" });
    const row = await pushRow(after);
    expect(row).toMatchObject({ category: "marketing" });
    expect(row!["data"]).toMatchObject({ consent: "true", push_topic: "promos" });
    const due = await val<string>(sql`SELECT public.push_quiet_hours_release(now())`);
    expect(new Date(row!["next_attempt_at"] as string).getTime()).toBeGreaterThanOrEqual(
      new Date(due).getTime() - 5000,
    );
  });

  it("quiet hours: 21:00–07:00 SAST holds marketing until 07:00 SAST; daytime goes now", async () => {
    const at = (iso: string) =>
      val<string>(sql`SELECT public.push_quiet_hours_release(${iso}::timestamptz)`);
    // SAST = UTC+2
    expect(new Date(await at("2026-10-23T20:30:00+02:00")).toISOString()).toBe(
      "2026-10-23T18:30:00.000Z",
    );
    expect(new Date(await at("2026-10-23T21:00:00+02:00")).toISOString()).toBe(
      "2026-10-24T05:00:00.000Z",
    );
    expect(new Date(await at("2026-10-23T23:59:00+02:00")).toISOString()).toBe(
      "2026-10-24T05:00:00.000Z",
    );
    expect(new Date(await at("2026-10-24T03:15:00+02:00")).toISOString()).toBe(
      "2026-10-24T05:00:00.000Z",
    );
    expect(new Date(await at("2026-10-24T07:00:00+02:00")).toISOString()).toBe(
      "2026-10-24T05:00:00.000Z",
    );
  });

  it("a new Journal article pushes only to members who opted into the Journal", async () => {
    const yes = await mkMember(sql);
    const no = await mkMember(sql);
    await subscribe(yes);
    await subscribe(no);
    await setTopic(yes, "journal", true);
    const slug = `push-test-${uid().slice(0, 8)}`;
    const [article] = await sql`
      INSERT INTO public.articles (slug, title, excerpt, body_md) VALUES (${slug}, 'A test article', 'x', 'y')
      RETURNING id`;
    const rows = await sql`SELECT recipient_user_id, template, data FROM public.notification_events
      WHERE dedupe_key LIKE ${"journalpush:" + article!["id"] + ":%"}`;
    expect(rows.map((r) => r["recipient_user_id"])).toEqual([yes]);
    expect(rows[0]).toMatchObject({ template: "journal_new" });
    expect(rows[0]!["data"]).toMatchObject({ slug, consent: "true" });
    await sql`DELETE FROM public.articles WHERE id = ${article!["id"]}`;
  });

  it("staff topics are for staff only; unknown topics are refused", async () => {
    const m = await mkMember(sql);
    expect((await attempt(setTopic(m, "staff_orders", false))).ok).toBe(false);
    expect(failedWith(await attempt(setTopic(m, "everything", true)), "unknown_topic")).toBe(true);
    const bud = await mkUser(sql, "budtender");
    expect(await setTopic(bud, "staff_orders", false)).toMatchObject({
      topic: "staff_orders",
      enabled: false,
    });
  });

  it("RLS: a member reads only their own devices (never the keys) and preferences; browsers write nothing", async () => {
    const a = await mkMember(sql);
    const b = await mkMember(sql);
    await subscribe(a);
    await subscribe(b);
    await setTopic(b, "promos", true);
    const own = await asUser(sql, a, (tx) => tx`SELECT id, user_id FROM public.push_subscriptions`);
    expect(own.map((r) => r["user_id"])).toEqual([a]);
    expect(
      await asUser(sql, a, (tx) => tx`SELECT * FROM public.notification_preferences`),
    ).toHaveLength(0);
    for (const col of ["endpoint", "p256dh", "auth"])
      expect(
        (
          await attempt(
            asUser(sql, a, (tx) => tx.unsafe(`SELECT ${col} FROM public.push_subscriptions`)),
          )
        ).ok,
        col,
      ).toBe(false);
    const writes: ((tx: Sql) => PromiseLike<unknown>)[] = [
      (tx) =>
        tx`INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (${a}, ${endpointFor()}, ${P256}, ${AUTH})`,
      (tx) => tx`DELETE FROM public.push_subscriptions WHERE user_id = ${a}`,
      (tx) => tx`UPDATE public.push_subscriptions SET topics = '{}'`,
      (tx) =>
        tx`INSERT INTO public.notification_preferences (user_id, topic, push_enabled) VALUES (${a}, 'promos', true)`,
      (tx) =>
        tx`SELECT public.push_subscribe(${a}, ${endpointFor()}, ${P256}, ${AUTH}, null, 'abcdefgh1')`,
      (tx) => tx`SELECT public.notification_set_preference(${a}, 'promos', true, 'abcdefgh2')`,
      (tx) =>
        tx`SELECT public.notification_enqueue_push(${a}, 'push_test', 'transactional', '{}'::jsonb, 'pt-x')`,
    ];
    for (const w of writes)
      expect((await attempt(asUser(sql, a, async (tx) => w(tx)))).ok).toBe(false);
    for (const w of writes)
      expect((await attempt(asAnon(sql, async (tx) => w(tx)))).ok).toBe(false);
    expect(
      await asAnon(sql, (tx) => tx`SELECT id FROM public.push_subscriptions`).catch(() => []),
    ).toHaveLength(0);
  });

  it("an endpoint re-registered by another member moves to them; unsubscribe removes only your own", async () => {
    const a = await mkMember(sql);
    const b = await mkMember(sql);
    const ep = await subscribe(a);
    await subscribe(b, ep);
    expect(
      await val<string>(
        sql`SELECT user_id::text FROM public.push_subscriptions WHERE endpoint = ${ep}`,
      ),
    ).toBe(b);
    expect(await rpc(sql, "push_unsubscribe", a, ep)).toBe(0);
    expect(await rpc(sql, "push_unsubscribe", b, ep)).toBe(1);
  });

  it("delivery bookkeeping: 404/410 removes the device, success resets failures", async () => {
    const m = await mkMember(sql);
    const ep = await subscribe(m);
    await rpc(sql, "push_record_delivery", ep, "failed");
    await rpc(sql, "push_record_delivery", ep, "ok");
    expect(
      await val<number>(
        sql`SELECT failure_count FROM public.push_subscriptions WHERE endpoint = ${ep}`,
      ),
    ).toBe(0);
    await rpc(sql, "push_record_delivery", ep, "gone");
    expect(
      await val<number>(
        sql`SELECT count(*)::int FROM public.push_subscriptions WHERE endpoint = ${ep}`,
      ),
    ).toBe(0);
  });

  it("the dispatcher claims only the channels it can send", async () => {
    const m = await mkMember(sql);
    await subscribe(m);
    const d = await email(m, "order_ready", "transactional", {});
    const ids = (
      await sql`SELECT id, channel FROM public.notification_events WHERE dedupe_key IN (${d}, ${d + ":push"})`
    ).map((r) => ({ id: r["id"] as string, channel: r["channel"] as string }));
    expect(ids.map((r) => r.channel).sort()).toEqual(["email", "push"]);
    const claimed =
      await sql`SELECT id, channel FROM public.notification_claim_channels(100, 60, ARRAY['push'])`;
    const mine = claimed.filter((r) => ids.some((i) => i.id === r["id"]));
    expect(mine.map((r) => r["channel"])).toEqual(["push"]);
    // the email row was not touched: no attempt burned while email is unconfigured
    expect(
      await val<number>(
        sql`SELECT attempts FROM public.notification_events WHERE dedupe_key = ${d}`,
      ),
    ).toBe(0);
  });

  it("a test push needs a device and is limited to the member's own devices", async () => {
    const m = await mkMember(sql);
    expect(
      await rpc(
        sql,
        "notification_enqueue_push",
        m,
        "push_test",
        "transactional",
        {},
        `pt:${uid()}`,
      ),
    ).toBeNull();
    await subscribe(m);
    const id = await rpc(
      sql,
      "notification_enqueue_push",
      m,
      "push_test",
      "transactional",
      {},
      `pt:${uid()}`,
    );
    expect(
      await val<string>(sql`SELECT recipient FROM public.notification_events WHERE id = ${id}`),
    ).toBe(m);
  });
});
