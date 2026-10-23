import type { PushMessage } from "./push-messages";
import type { SendResult } from "./dispatch";

/**
 * Web push sender. Encryption (RFC 8291 aes128gcm) and VAPID signing (RFC 8292) come from the `web-push`
 * package — the deployed runtime is Node on Vercel — but the HTTP request goes through an injected fetch so
 * tests can stand in for the push services.
 */
export interface PushDevice {
  endpoint: string;
  p256dh: string;
  auth: string;
  topics: string[];
}
export interface PushStore {
  devices(userId: string): Promise<PushDevice[]>;
  record(endpoint: string, outcome: "ok" | "gone" | "failed"): Promise<void>;
}
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}
export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array },
) => Promise<{ status: number; text(): Promise<string> }>;

export type RequestBuilder = (
  device: PushDevice,
  payload: string,
  vapid: VapidConfig,
) => Promise<{ endpoint: string; headers: Record<string, string>; body: Uint8Array }>;

export const webPushRequest: RequestBuilder = async (device, payload, vapid) => {
  const webpush = (await import("web-push")).default;
  const d = webpush.generateRequestDetails(
    { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
    payload,
    {
      vapidDetails: vapid,
      TTL: 60 * 60 * 12,
      contentEncoding: "aes128gcm",
      urgency: "normal",
    },
  );
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.headers ?? {})) headers[k] = String(v);
  return { endpoint: d.endpoint, headers, body: new Uint8Array(d.body as Buffer) };
};

export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const publicKey = env["VAPID_PUBLIC_KEY"]?.trim();
  const privateKey = env["VAPID_PRIVATE_KEY"]?.trim();
  const subject = env["VAPID_SUBJECT"]?.trim() || "mailto:info@cannaplug012.co.za";
  if (!publicKey || !privateKey || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/** Sends one queued push to every device of the member that takes this topic. */
export function pushAdapter(deps: {
  store: PushStore;
  vapid: VapidConfig;
  fetch: PushFetch;
  build?: RequestBuilder;
}) {
  const build = deps.build ?? webPushRequest;
  return async (m: {
    id: string;
    userId: string;
    topic: string;
    message: PushMessage;
  }): Promise<SendResult> => {
    const devices = (await deps.store.devices(m.userId)).filter(
      (d) => m.topic === "test" || d.topics.length === 0 || d.topics.includes(m.topic),
    );
    if (devices.length === 0) return { ok: true, messageId: "no-devices" };
    const payload = JSON.stringify(m.message);
    let delivered = 0;
    let retryable = 0;
    let rejected = 0;
    for (const device of devices) {
      try {
        const req = await build(device, payload, deps.vapid);
        const res = await deps.fetch(req.endpoint, {
          method: "POST",
          headers: req.headers,
          body: req.body,
        });
        if (res.status >= 200 && res.status < 300) {
          delivered++;
          await deps.store.record(device.endpoint, "ok");
        } else if (res.status === 404 || res.status === 410) {
          await deps.store.record(device.endpoint, "gone"); // the browser dropped this subscription
        } else {
          await deps.store.record(device.endpoint, "failed");
          if (res.status === 429 || res.status >= 500) retryable++;
          else rejected++; // 400/401/403/413: our request is wrong (often VAPID keys) — retrying will not help
        }
      } catch {
        await deps.store.record(device.endpoint, "failed").catch(() => undefined);
        retryable++;
      }
    }
    if (delivered > 0) return { ok: true, messageId: `push:${delivered}/${devices.length}` };
    if (retryable > 0) return { ok: false, error: "push_unavailable", permanent: false };
    if (rejected > 0) return { ok: false, error: "push_rejected", permanent: true };
    return { ok: true, messageId: "no-live-devices" }; // every device was gone or refused: nothing left to retry
  };
}
