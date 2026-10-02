import { describe, expect, it, vi } from "vitest";
import { adaptersFromEnv, resendAdapter, type Fetch } from "@/lib/notifications/adapters";
import {
  dispatchBatch,
  type NotificationDb,
  type QueuedNotification,
  type SendResult,
} from "@/lib/notifications/dispatch";
import { TEMPLATES, renderTemplate } from "@/lib/notifications/templates";

const ctx = { siteUrl: "https://cannaplug012.co.za" };
const data = {
  order_number: "CP-100",
  total_rand: 1234.5,
  contact_name: "Ada <script>alert(1)</script> Lovelace",
  delivery_method: "delivery",
  payment_method: "eft",
};

describe("templates", () => {
  it("renders every registered template to subject, html and text", () => {
    for (const name of Object.keys(TEMPLATES)) {
      const r = renderTemplate(name, data, ctx)!;
      expect(r.subject.length, name).toBeGreaterThan(5);
      expect(r.html, name).toContain("Cannaplug");
      expect(r.text.length, name).toBeGreaterThan(20);
      expect(r.text, name).not.toMatch(/<[a-z]/i);
    }
  });
  it("escapes member-controlled values and formats rand", () => {
    const r = renderTemplate("order_confirmed", data, ctx)!;
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("Hi Ada");
    expect(r.html).toMatch(/R1\s234,50/);
  });
  it("only ready/out-for-delivery carry an SMS short form", () => {
    expect(renderTemplate("order_ready", data, ctx)!.sms).toContain("CP-100");
    expect(renderTemplate("order_out_for_delivery", data, ctx)!.sms).toBeTruthy();
    expect(renderTemplate("order_received", data, ctx)!.sms).toBeUndefined();
  });
  it("unknown templates render to null", () => expect(renderTemplate("nope", {}, ctx)).toBeNull());
});

describe("adapters", () => {
  const res = (status: number, body: unknown = {}) => ({
    ok: status < 300,
    status,
    text: async () => JSON.stringify(body),
  });
  const msg = { id: "n-1", to: "a@example.com", subject: "S", html: "<p>h</p>", text: "t" };
  it("Resend: sends from the support address with the notification id as Idempotency-Key", async () => {
    const f = vi.fn<Fetch>(async () => res(200, { id: "re_1" }));
    expect(await resendAdapter({ apiKey: "re_key" }, f)(msg)).toEqual({
      ok: true,
      messageId: "re_1",
    });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init!.headers!["Idempotency-Key"]).toBe("n-1");
    expect(JSON.parse(init!.body!)).toMatchObject({
      from: "Cannaplug Support <updates@cannaplug012.co.za>",
      to: ["a@example.com"],
    });
  });
  it("classifies failures: 4xx permanent, 429/5xx retryable", async () => {
    const mk = (s: number) => resendAdapter({ apiKey: "k" }, async () => res(s));
    expect(await mk(422)(msg)).toMatchObject({ ok: false, permanent: true });
    expect(await mk(403)(msg)).toMatchObject({ ok: false, permanent: true });
    expect(await mk(429)(msg)).toMatchObject({ ok: false, permanent: false });
    expect(await mk(503)(msg)).toMatchObject({ ok: false, permanent: false });
  });
  it("channels exist only when configured; WhatsApp numbers are prefixed", async () => {
    expect(adaptersFromEnv({}, vi.fn())).toEqual({});
    const f = vi.fn<Fetch>(async () => res(201, { sid: "SM1" }));
    const a = adaptersFromEnv(
      {
        RESEND_API_KEY: "k",
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
        TWILIO_WHATSAPP_FROM: "+14155550100",
      },
      f,
    );
    expect(a.email).toBeTruthy();
    expect(a.sms).toBeUndefined();
    await a.whatsapp!({ id: "1", to: "+27820000000", body: "hi" });
    const body = new URLSearchParams(f.mock.calls[0]![1]!.body!);
    expect(body.get("To")).toBe("whatsapp:+27820000000");
    expect(body.get("From")).toBe("whatsapp:+14155550100");
  });
});

describe("dispatchBatch", () => {
  const row = (over: Partial<QueuedNotification> = {}): QueuedNotification => ({
    id: Math.random().toString(36).slice(2),
    channel: "email",
    template: "order_confirmed",
    recipient: "a@example.com",
    data,
    attempts: 1,
    ...over,
  });
  function mkDb(rows: QueuedNotification[]) {
    const done: { id: string; r: SendResult }[] = [];
    const db: NotificationDb = {
      claim: vi.fn(async () => rows),
      complete: vi.fn(async (id, r) => void done.push({ id, r })),
    };
    return { db, done };
  }
  const ok = async () => ({ ok: true as const, messageId: "m" });

  it("sends, records, and summarises", async () => {
    const { db, done } = mkDb([row(), row()]);
    const s = await dispatchBatch({ db, adapters: { email: ok }, siteUrl: "https://x" });
    expect(s).toMatchObject({ claimed: 2, sent: 2, retried: 0, dead: 0 });
    expect(done.every((d) => d.r.ok)).toBe(true);
  });
  it("claims nothing while email is unconfigured, so attempts are not burned", async () => {
    const { db } = mkDb([row()]);
    const s = await dispatchBatch({ db, adapters: {}, siteUrl: "https://x" });
    expect(s.skippedNotConfigured).toBe(true);
    expect(db.claim).not.toHaveBeenCalled();
  });
  it("an unknown template is a permanent failure; a thrown adapter is retryable; one bad row never stops the batch", async () => {
    const { db, done } = mkDb([row({ template: "ghost" }), row(), row()]);
    let n = 0;
    const s = await dispatchBatch({
      db,
      adapters: {
        email: async () => {
          if (n++ === 0) throw new Error("socket hang up");
          return { ok: true as const, messageId: "m" };
        },
      },
      siteUrl: "https://x",
    });
    expect(s).toMatchObject({ claimed: 3, sent: 1, retried: 1, dead: 1 });
    expect(done[0]!.r).toMatchObject({ ok: false, permanent: true });
  });
  it("sms rows without a configured adapter retry; templates without a short form die", async () => {
    const { db, done } = mkDb([
      row({ channel: "sms", template: "order_ready" }),
      row({ channel: "sms", template: "order_confirmed" }),
    ]);
    await dispatchBatch({ db, adapters: { email: ok }, siteUrl: "https://x" });
    expect(done[0]!.r).toMatchObject({ ok: false, permanent: false });
    const { db: db2, done: d2 } = mkDb([row({ channel: "sms", template: "order_confirmed" })]);
    await dispatchBatch({ db: db2, adapters: { email: ok, sms: ok }, siteUrl: "https://x" });
    expect(d2[0]!.r).toMatchObject({ ok: false, permanent: true });
  });
  it("hands rows back untouched once the time budget is spent", async () => {
    const { db, done } = mkDb([row(), row()]);
    let t = 0;
    const s = await dispatchBatch({
      db,
      adapters: { email: ok },
      siteUrl: "https://x",
      now: () => (t += 30_000),
      budgetMs: 20_000,
    });
    expect(s.sent).toBe(0);
    expect(done.every((d) => !d.r.ok && !d.r.permanent)).toBe(true);
  });
});

describe("template coverage", () => {
  it("every template the database can enqueue has a renderer (no dead-lettered emails)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../../supabase/migrations/", import.meta.url).pathname;
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(dir + f, "utf8");
      for (const m of sql.matchAll(
        /notification_enqueue\(\s*'(?:email|sms|whatsapp)',\s*'([a-z0-9_]+)'/g,
      ))
        used.add(m[1]!);
      for (const m of sql.matchAll(/notification_enqueue_staff\(\s*'([a-z0-9_]+)'/g))
        used.add(m[1]!);
      for (const m of sql.matchAll(/v_template := CASE[\s\S]*?END;/g))
        for (const t of m[0].matchAll(/THEN '([a-z_]+)'/g)) used.add(t[1]!);
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((t) => !(t in TEMPLATES))).toEqual([]);
  });
  it("every template has sample data (previews and test sends)", async () => {
    const { SAMPLES } = await import("../../scripts/email-samples");
    expect(Object.keys(TEMPLATES).filter((t) => !(t in SAMPLES))).toEqual([]);
  });
});
