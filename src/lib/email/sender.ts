/**
 * Who CannaPlug email comes from. Everything (order, ID, receipt and marketing email) is sent as
 * "Cannaplug Support <admin@cannaplug012.co.za>" and replies go to admin@cannaplug012.co.za.
 *
 * Until cannaplug012.co.za itself is verified in Resend (its DNS records live at GoDaddy), Resend refuses that
 * address. Rather than lose the email, the send is retried once from the verified subdomain
 * (admin@updates.cannaplug012.co.za). Once the main domain verifies, the fallback is simply never used.
 */
export const EMAIL_FROM = "Cannaplug Support <admin@cannaplug012.co.za>";
export const EMAIL_FROM_FALLBACK = "Cannaplug Support <admin@updates.cannaplug012.co.za>";
export const EMAIL_REPLY_TO = "admin@cannaplug012.co.za";

export type Sender = { from: string; fallback: string | null; replyTo: string };

export function senderFromEnv(env: Record<string, string | undefined>): Sender {
  const from = env["NOTIFY_FROM_EMAIL"]?.trim() || EMAIL_FROM;
  const fb = env["NOTIFY_FROM_FALLBACK"]?.trim();
  return {
    from,
    fallback: fb === "none" ? null : fb || (from === EMAIL_FROM ? EMAIL_FROM_FALLBACK : null),
    replyTo: env["NOTIFY_REPLY_TO"]?.trim() || EMAIL_REPLY_TO,
  };
}

/** Resend's answer when the From domain is not (yet) verified on the account. */
export function isUnverifiedSender(status: number, body: string): boolean {
  return (status === 403 || status === 422) && /domain.{0,40}(not verified|verify)/i.test(body);
}

export type ResendFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * POST one email to Resend from `sender.from`, falling back to `sender.fallback` only when Resend says the
 * sending domain is unverified. `payload` must not contain `from`; `reply_to` defaults to the support inbox.
 */
export async function sendWithResend(
  fetchFn: ResendFetch,
  apiKey: string,
  sender: Sender,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{ status: number; body: string; from: string }> {
  const attempt = async (from: string, key: string) => {
    const res = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ reply_to: sender.replyTo, ...payload, from }),
    });
    return { status: res.status, body: await res.text(), from };
  };
  const first = await attempt(sender.from, idempotencyKey);
  if (
    sender.fallback &&
    sender.fallback !== sender.from &&
    isUnverifiedSender(first.status, first.body)
  )
    return attempt(sender.fallback, `${idempotencyKey}:fallback`);
  return first;
}
