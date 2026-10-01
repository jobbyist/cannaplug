import { readFileSync } from "node:fs";
import WebSocket from "ws";
import type { Page } from "@playwright/test";
import { ANON, API, PASSWORD, RUN_FILE, sql } from "./db";

export { ANON, API, PASSWORD, sql };

/** Users created fresh for THIS run by global-setup (so the suite is re-runnable). */
const run = JSON.parse(readFileSync(RUN_FILE, "utf8")) as {
  member: string;
  other: string;
  manager: string;
};
export const MEMBER = run.member;
export const OTHER = run.other;
export const MANAGER = run.manager;

export const userId = (email: string) => sql(`select id from auth.users where email='${email}'`);
export const productId = (slug: string) =>
  sql(`select id from public.products where slug='${slug}'`);
export const uniq = (p = "k") => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Server-priced online order for a member (what checkout / reorder do). Returns the order id. */
export function createOrder(email: string, slug: string, qty: number): string {
  const r = sql(
    `select (public.create_online_order('${userId(email)}', '[{"product_id":"${productId(slug)}","quantity":${qty}}]'::jsonb, 'Live Member', '0820000000', null, '${uniq("ord")}', 30)->>'order_id');`,
  );
  return r.split("\n").pop()!;
}

export function transition(orderId: string, to: string, note = "internal staff note") {
  sql(
    `select public.transition_order_status('${orderId}'::uuid, '${to}', '${userId(MANAGER)}'::uuid, '${note}');`,
  );
}

export function completeOrder(orderId: string) {
  for (const s of ["confirmed", "packing", "ready", "out_for_delivery", "completed"])
    transition(orderId, s);
}

export async function signInUi(page: Page, email: string) {
  await page.goto("/account");
  // The sign-in form's <Label>s are not associated with their inputs (pre-existing), so target by type.
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Password-grant sign-in straight against GoTrue: returns the member's JWT (for raw API/WS clients). */
export async function accessToken(email: string): Promise<string> {
  const res = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function rest(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, body };
}

export type RtEvent = { table: string; type: string; record: Record<string, unknown> | null };

/**
 * A raw Supabase-Realtime (Phoenix) client authenticated as `token`, subscribed with NO client-side
 * filter, so the only thing limiting what it receives is the database's RLS + column privileges.
 */
export async function realtimeClient(token: string, tables: string[]) {
  const events: RtEvent[] = [];
  const ws = new WebSocket(
    `${API.replace("http", "ws")}/realtime/v1/websocket?apikey=${ANON}&vsn=1.0.0`,
  );
  let ref = 0;
  const send = (topic: string, event: string, payload: unknown) =>
    ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref) }));
  // Ready only when Realtime confirms "Subscribed to PostgreSQL" — the join reply alone arrives earlier,
  // and changes made in between would be (correctly) missed.
  const joined = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("realtime subscribe timed out")), 30_000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (
        msg.event === "phx_reply" &&
        msg.topic === "realtime:live-test" &&
        msg.payload.status !== "ok"
      ) {
        clearTimeout(timer);
        reject(new Error(`join refused: ${JSON.stringify(msg.payload)}`));
      }
      if (msg.event === "system" && msg.payload?.extension === "postgres_changes") {
        clearTimeout(timer);
        if (msg.payload.status === "ok") resolve();
        else reject(new Error(`subscribe failed: ${JSON.stringify(msg.payload)}`));
      }
      if (msg.event === "postgres_changes") {
        const d = msg.payload.data;
        events.push({ table: d.table, type: d.type, record: d.record ?? null });
      }
    });
    ws.on("error", reject);
  });
  await new Promise<void>((r, j) => {
    ws.on("open", () => r());
    ws.on("error", j);
  });
  send("realtime:live-test", "phx_join", {
    config: {
      broadcast: { ack: false, self: false },
      presence: { key: "" },
      postgres_changes: tables.map((table) => ({ event: "*", schema: "public", table })),
      private_channel: false,
    },
    access_token: token,
  });
  await joined;
  const hb = setInterval(() => send("phoenix", "heartbeat", {}), 20_000);
  return {
    events,
    close: () => {
      clearInterval(hb);
      ws.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
