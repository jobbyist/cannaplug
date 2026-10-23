import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// http_ece is web-push's own RFC 8188/8291 implementation; used here only to DECRYPT what we send.
import ece from "http_ece";
import webpush from "web-push";
import {
  dispatchBatch,
  type NotificationDb,
  type QueuedNotification,
} from "@/lib/notifications/dispatch";
import { PUSH_MESSAGES, pushMessage } from "@/lib/notifications/push-messages";
import {
  pushAdapter,
  vapidFromEnv,
  webPushRequest,
  type PushDevice,
  type PushStore,
} from "@/lib/notifications/push";
import { PUSH_TOPICS } from "@/lib/push-topics";

const migration = readFileSync(
  join(__dirname, "..", "..", "supabase/migrations/20261023006000_web_push.sql"),
  "utf8",
);
const b64url = (b: Buffer) => b.toString("base64url");

describe("push payloads carry a title, a neutral body and a same-site URL only", () => {
  // Everything a template's data could hold — none of it may reach a lock screen except a valid order number.
  const rich = {
    order_number: "CP-2610-0042",
    contact_name: "Thandi Mokoena",
    total_rand: 1234.5,
    items: [{ name: "Blue Gelato 3.5g", quantity: 2 }],
    product_name: "Blue Gelato 3.5g",
    reason: "ID photo blurry — date of birth unreadable",
    document_expires_on: "2026-11-30",
    diagnosis: "chronic pain",
    prescription: "CBD oil 10%",
    note: "please call",
    email: "thandi@example.com",
    title: "Terpenes 101",
    slug: "terpenes-101",
  };
  const forbidden = [
    "Thandi",
    "Mokoena",
    "1234",
    "1 234",
    "Blue Gelato",
    "3.5g",
    "blurry",
    "birth",
    "2026-11-30",
    "chronic",
    "pain",
    "CBD",
    "prescription",
    "please call",
    "@",
    "approved",
    "rejected",
    "declined",
  ];

  it("every pushed template has a message, and none leaks clinical, ID, order-item or personal text", () => {
    // the templates the database maps to a topic (inside push_topic_for, before each THEN)
    const fn = migration.slice(migration.indexOf("FUNCTION public.push_topic_for"));
    const body = fn.slice(0, fn.indexOf("$$;", fn.indexOf("AS $$") + 5));
    const mapped = [...body.matchAll(/WHEN ([\s\S]*?)THEN/g)].flatMap((m) =>
      [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!),
    );
    expect(mapped.length).toBeGreaterThan(15);
    for (const t of new Set(mapped)) expect(PUSH_MESSAGES[t], t).toBeDefined();
    for (const [template] of Object.entries(PUSH_MESSAGES)) {
      const m = pushMessage(template, rich, "n1")!;
      expect(Object.keys(m).sort()).toEqual(["body", "tag", "title", "url"]);
      const text = `${m.title} ${m.body}`;
      for (const f of forbidden)
        if (!(template === "journal_new" && f === "Terpenes 101"))
          expect(text, `${template}: ${f}`).not.toContain(f);
      expect(m.url, template).toMatch(/^\/[a-z0-9/-]*$/);
      expect(m.body.length).toBeLessThanOrEqual(120);
    }
    expect(pushMessage("order_ready", rich, "n1")!.body).toBe("Order CP-2610-0042 is ready.");
    expect(pushMessage("journal_new", rich, "n1")).toMatchObject({
      body: "Terpenes 101",
      url: "/journal/terpenes-101",
    });
  });

  it("never trusts data: a malformed order number or slug is dropped, HTML stripped, unknown templates refused", () => {
    expect(pushMessage("order_ready", { order_number: "<b>x</b>" }, "n")!.body).toBe(
      "Your order is ready.",
    );
    expect(
      pushMessage("journal_new", { slug: "../../admin", title: "<script>x" }, "n"),
    ).toMatchObject({
      url: "/journal",
      body: "scriptx",
    });
    expect(pushMessage("contact_form_staff", rich, "n")).toBeNull();
    expect(pushMessage("member_welcome", rich, "n")).toBeNull();
  });

  it("the topic list in the app matches the database's topics and defaults", () => {
    for (const t of PUSH_TOPICS) {
      const re = new RegExp(
        `WHEN '${t.id}'\\s+THEN '\\{"default": ${t.defaultOn},\\s+"marketing": ${t.marketing},\\s+"staff": ${t.staff}\\}'`,
      );
      expect(migration, t.id).toMatch(re);
    }
    expect([...migration.matchAll(/WHEN '([a-z_]+)'\s+THEN '\{"default"/g)].length).toBe(
      PUSH_TOPICS.length,
    );
  });

  it("the service worker shows only those fields and opens same-site paths only", () => {
    const sw = readFileSync(join(__dirname, "..", "..", "public/sw.js"), "utf8");
    const mod = { exports: {} as { safePath(u: unknown): string } };
    new Function("module", "URL", sw)(mod, URL);
    expect(mod.exports.safePath("/account")).toBe("/account");
    expect(mod.exports.safePath("/journal/a-b?x=1")).toBe("/journal/a-b?x=1");
    for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", 42, null])
      expect(mod.exports.safePath(bad)).toBe("/");
  });
});

describe("push sending", () => {
  const vapid = { ...webpush.generateVAPIDKeys(), subject: "mailto:info@cannaplug012.co.za" };
  function device(topics: string[] = []) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const d: PushDevice = {
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString("hex")}`,
      p256dh: b64url(ecdh.getPublicKey()),
      auth: b64url(auth),
      topics,
    };
    return { d, ecdh, auth };
  }
  const msg = {
    title: "Ready for you",
    body: "Order CP-2610-0042 is ready.",
    url: "/account",
    tag: "t",
  };

  it("encrypts with aes128gcm for the device's keys and signs with VAPID (decrypts back exactly)", async () => {
    const { d, ecdh, auth } = device();
    const req = await webPushRequest(d, JSON.stringify(msg), vapid);
    expect(req.endpoint).toBe(d.endpoint);
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(req.headers["Authorization"]).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`),
    );
    expect(JSON.stringify(req.body)).not.toContain("CP-2610"); // ciphertext, not the message
    const plain = ece.decrypt(Buffer.from(req.body), {
      version: "aes128gcm",
      privateKey: ecdh,
      authSecret: auth,
    });
    expect(JSON.parse(plain.toString())).toEqual(msg);
    // the JWT audience is the push service's origin and it expires within 24 h
    const jwt = /t=([^,]+)/.exec(req.headers["Authorization"]!)![1]!;
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  function store(devices: PushDevice[]) {
    const records: [string, string][] = [];
    const s: PushStore = {
      devices: vi.fn(async () => devices),
      record: vi.fn(async (e, o) => void records.push([e, o])),
    };
    return { s, records };
  }
  const build = async (dev: PushDevice) => ({
    endpoint: dev.endpoint,
    headers: {},
    body: new Uint8Array([1]),
  });

  it("delivers to each device on the topic; removes 404/410 devices; retries 429/5xx; 4xx is permanent", async () => {
    const a = device().d;
    const b = device(["orders"]).d;
    const c = device(["promos"]).d; // this device does not take order alerts
    const { s, records } = store([a, b, c]);
    const statuses = new Map([
      [a.endpoint, 201],
      [b.endpoint, 410],
    ]);
    const send = pushAdapter({
      store: s,
      vapid,
      build,
      fetch: async (u) => ({ status: statuses.get(u) ?? 500, text: async () => "" }),
    });
    expect(await send({ id: "1", userId: "u", topic: "orders", message: msg })).toEqual({
      ok: true,
      messageId: "push:1/2",
    });
    expect(records).toEqual([
      [a.endpoint, "ok"],
      [b.endpoint, "gone"],
    ]);

    const retry = pushAdapter({
      store: store([a]).s,
      vapid,
      build,
      fetch: async () => ({ status: 503, text: async () => "" }),
    });
    expect(await retry({ id: "2", userId: "u", topic: "orders", message: msg })).toMatchObject({
      ok: false,
      permanent: false,
    });
    const bad = pushAdapter({
      store: store([a]).s,
      vapid,
      build,
      fetch: async () => ({ status: 403, text: async () => "" }),
    });
    expect(await bad({ id: "3", userId: "u", topic: "orders", message: msg })).toMatchObject({
      ok: false,
      permanent: true,
    });
    const gone = pushAdapter({
      store: store([a]).s,
      vapid,
      build,
      fetch: async () => ({ status: 404, text: async () => "" }),
    });
    expect(await gone({ id: "4", userId: "u", topic: "orders", message: msg })).toEqual({
      ok: true,
      messageId: "no-live-devices",
    });
    const none = pushAdapter({ store: store([]).s, vapid, build, fetch: vi.fn() });
    expect(await none({ id: "5", userId: "u", topic: "orders", message: msg })).toEqual({
      ok: true,
      messageId: "no-devices",
    });
  });

  it("VAPID config needs both keys and a mailto/https subject", () => {
    expect(vapidFromEnv({})).toBeNull();
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "k" })).toMatchObject({
      subject: "mailto:info@cannaplug012.co.za",
    });
    expect(
      vapidFromEnv({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "k", VAPID_SUBJECT: "ftp://x" }),
    ).toBeNull();
  });

  it("the dispatcher sends push rows through the push adapter with the topic, alongside email", async () => {
    const rows: QueuedNotification[] = [
      {
        id: "e1",
        channel: "email",
        template: "order_ready",
        recipient: "a@example.com",
        data: { order_number: "CP-2610-0042" },
        attempts: 1,
      },
      {
        id: "p1",
        channel: "push",
        template: "order_ready",
        recipient: "user-1",
        data: { order_number: "CP-2610-0042", push_topic: "orders" },
        attempts: 1,
      },
    ];
    const claim = vi.fn(async () => rows);
    const db: NotificationDb = { claim, complete: vi.fn(async () => undefined) };
    const push = vi.fn(async () => ({ ok: true as const, messageId: "push:1/1" }));
    const email = vi.fn(async () => ({ ok: true as const, messageId: "m" }));
    const s = await dispatchBatch({ db, adapters: { email, push }, siteUrl: "https://x" });
    expect(s).toMatchObject({ claimed: 2, sent: 2 });
    expect(claim).toHaveBeenCalledWith(25, 120, ["email", "push"]);
    expect(push).toHaveBeenCalledWith({
      id: "p1",
      userId: "user-1",
      topic: "orders",
      message: {
        title: "Ready for you",
        body: "Order CP-2610-0042 is ready.",
        url: "/account",
        tag: "order_ready:p1",
      },
    });
    // push alone still runs (email unconfigured): only push rows are claimed
    claim.mockClear();
    await dispatchBatch({ db, adapters: { push }, siteUrl: "https://x" });
    expect(claim).toHaveBeenCalledWith(25, 120, ["push"]);
  });
});
