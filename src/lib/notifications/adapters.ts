import type { ChannelAdapters, SendResult } from "./dispatch";

export type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export const DEFAULT_FROM = "Cannaplug Support <updates@cannaplug.co.za>";

/** HTTP status → verdict. 4xx other than 408/429 means the message itself is bad, so retrying is pointless. */
function verdict(status: number, body: string): SendResult | null {
  if (status >= 200 && status < 300) return null;
  const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return { ok: false, error: `http_${status}:${body.slice(0, 120)}`, permanent };
}

export function resendAdapter(
  cfg: { apiKey: string; from?: string },
  fetchFn: Fetch,
): NonNullable<ChannelAdapters["email"]> {
  return async (m) => {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": m.id,
      },
      body: JSON.stringify({
        from: cfg.from ?? DEFAULT_FROM,
        to: [m.to],
        subject: m.subject,
        html: m.html,
        text: m.text,
      }),
    });
    const text = await res.text();
    const bad = verdict(res.status, text);
    if (bad) return bad;
    try {
      const id = (JSON.parse(text) as { id?: unknown }).id;
      return { ok: true, messageId: typeof id === "string" ? id : "unknown" };
    } catch {
      return { ok: true, messageId: "unknown" };
    }
  };
}

function twilio(
  cfg: { accountSid: string; authToken: string; from: string; whatsapp?: boolean },
  fetchFn: Fetch,
) {
  return async (m: { id: string; to: string; body: string }): Promise<SendResult> => {
    const to = cfg.whatsapp ? `whatsapp:${m.to}` : m.to;
    const from =
      cfg.whatsapp && !cfg.from.startsWith("whatsapp:") ? `whatsapp:${cfg.from}` : cfg.from;
    const res = await fetchFn(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: m.body }).toString(),
      },
    );
    const text = await res.text();
    const bad = verdict(res.status, text);
    if (bad) return bad;
    try {
      return {
        ok: true,
        messageId: String((JSON.parse(text) as { sid?: unknown }).sid ?? "unknown"),
      };
    } catch {
      return { ok: true, messageId: "unknown" };
    }
  };
}

export function adaptersFromEnv(
  env: Record<string, string | undefined>,
  fetchFn: Fetch,
): ChannelAdapters {
  const out: ChannelAdapters = {};
  const key = env["RESEND_API_KEY"]?.trim();
  if (key)
    out.email = resendAdapter(
      { apiKey: key, from: env["NOTIFY_FROM_EMAIL"]?.trim() || DEFAULT_FROM },
      fetchFn,
    );
  const sid = env["TWILIO_ACCOUNT_SID"]?.trim();
  const tok = env["TWILIO_AUTH_TOKEN"]?.trim();
  if (sid && tok) {
    const sms = env["TWILIO_SMS_FROM"]?.trim();
    const wa = env["TWILIO_WHATSAPP_FROM"]?.trim();
    if (sms) out.sms = twilio({ accountSid: sid, authToken: tok, from: sms }, fetchFn);
    if (wa)
      out.whatsapp = twilio({ accountSid: sid, authToken: tok, from: wa, whatsapp: true }, fetchFn);
  }
  return out;
}
