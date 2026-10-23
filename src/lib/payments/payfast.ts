import { createHash, timingSafeEqual } from "node:crypto";
import {
  ProviderError,
  type CheckoutRequest,
  type CheckoutSession,
  type FetchLike,
  type Mode,
  type PaymentProvider,
  type VerifiedFacts,
  type VerifyOutcome,
} from "./provider";

/**
 * PayFast (ZAR card, Instant EFT and the other methods PayFast offers on its hosted page).
 *
 * Checkout: the member's browser POSTs a signed form to {host}/eng/process. The signature is
 *   md5( "k1=v1&k2=v2..." [+ "&passphrase=..."] )
 * over the non-blank fields IN PayFast's documented order, values trimmed and URL-encoded the PHP
 * `urlencode` way (uppercase hex, spaces as "+").
 *
 * ITN (Instant Transaction Notification), per PayFast's "Conduct security checks":
 *   1. signature over every posted field in the order received, except `signature` (blank values included);
 *   2. the request comes from a PayFast server (www / w1w / w2w / sandbox .payfast.co.za);
 *   3. the amount matches what we asked for (done by the database, `payments_apply_verified_event`);
 *   4. PayFast itself confirms the data: POST the same param string to {host}/eng/query/validate → "VALID".
 */
export const PAYFAST_HOSTS = {
  live: "www.payfast.co.za",
  sandbox: "sandbox.payfast.co.za",
} as const;
export const PAYFAST_ITN_HOSTS = [
  "www.payfast.co.za",
  "w1w.payfast.co.za",
  "w2w.payfast.co.za",
  "sandbox.payfast.co.za",
] as const;
/** PayFast refuses payments below R5.00. */
export const PAYFAST_MIN_RAND = 5;

/** Field order PayFast signs a checkout in. Anything else is never sent. */
export const PAYFAST_FIELD_ORDER = [
  "merchant_id",
  "merchant_key",
  "return_url",
  "cancel_url",
  "notify_url",
  "name_first",
  "name_last",
  "email_address",
  "cell_number",
  "m_payment_id",
  "amount",
  "item_name",
  "item_description",
  "custom_int1",
  "custom_int2",
  "custom_int3",
  "custom_int4",
  "custom_int5",
  "custom_str1",
  "custom_str2",
  "custom_str3",
  "custom_str4",
  "custom_str5",
  "email_confirmation",
  "confirmation_address",
  "payment_method",
] as const;

export interface PayFastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase: string | null;
  sandbox: boolean;
  /** Test-only: point checkout and validation at a mock server. */
  baseOverride?: string | undefined;
  /** Default true. Only tests turn the source-IP check off. */
  checkSourceIp?: boolean;
}

export function payfastFromEnv(env: Record<string, string | undefined>): PayFastConfig | null {
  const merchantId = env["PAYFAST_MERCHANT_ID"]?.trim();
  const merchantKey = env["PAYFAST_MERCHANT_KEY"]?.trim();
  if (!merchantId || !merchantKey || !/^[0-9]{5,12}$/.test(merchantId)) return null;
  const envName = (env["PAYFAST_ENV"] ?? "live").trim().toLowerCase();
  // Tests only: a local mock (plain http on localhost). Never honoured for any other host.
  const override = env["PAYFAST_API_BASE"]?.trim();
  const local = !!override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(override);
  return {
    merchantId,
    merchantKey,
    passphrase: env["PAYFAST_PASSPHRASE"]?.trim() || null,
    sandbox: envName === "sandbox",
    ...(local ? { baseOverride: override, checkSourceIp: false } : {}),
  };
}

/** PHP urlencode: RFC 3986 unreserved + nothing else, uppercase hex, spaces as "+". */
export function pfEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

export function pfParamString(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${k}=${pfEncode(v)}`).join("&");
}

export function pfSignature(paramString: string, passphrase: string | null): string {
  const withPass = passphrase ? `${paramString}&passphrase=${pfEncode(passphrase)}` : paramString;
  return createHash("md5").update(withPass).digest("hex");
}

/** Checkout fields in PayFast's order, blanks dropped, plus the signature. */
export function signCheckoutFields(
  fields: Partial<Record<(typeof PAYFAST_FIELD_ORDER)[number], string>>,
  passphrase: string | null,
): [string, string][] {
  const pairs: [string, string][] = [];
  for (const k of PAYFAST_FIELD_ORDER) {
    const v = fields[k]?.trim();
    if (v) pairs.push([k, v]);
  }
  return [...pairs, ["signature", pfSignature(pfParamString(pairs), passphrase)]];
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Parses an ITN body keeping PayFast's field order. Returns null for anything that is not a form body. */
export function parseItn(raw: string): [string, string][] | null {
  if (!raw || raw.length > 20_000 || !raw.includes("=") || /[\r\n]/.test(raw)) return null;
  try {
    const pairs = [...new URLSearchParams(raw).entries()];
    return pairs.length && pairs.every(([k]) => /^[a-z0-9_]{1,40}$/.test(k)) ? pairs : null;
  } catch {
    return null;
  }
}

/** Check 1: signature over every posted field except `signature`, in the order posted. */
export function verifyItnSignature(pairs: [string, string][], passphrase: string | null): boolean {
  const sig = pairs.find(([k]) => k === "signature")?.[1];
  if (!sig || !/^[a-f0-9]{32}$/i.test(sig)) return false;
  const unsigned = pairs.filter(([k]) => k !== "signature");
  return safeEqual(pfSignature(pfParamString(unsigned), passphrase), sig.toLowerCase());
}

const str = (v: string | undefined | null, max = 200): string | null =>
  v && v.length > 0 && v.length <= max ? v : null;

export function payfastFacts(fields: Map<string, string>, mode: Mode): VerifiedFacts {
  const gross = fields.get("amount_gross") ?? "";
  const amount = /^[0-9]{1,9}(\.[0-9]{1,2})?$/.test(gross) ? Math.round(Number(gross) * 100) : null;
  const txId = str(fields.get("m_payment_id"));
  const base = {
    transaction_id: txId,
    provider_ref: txId,
    provider_payment_id: str(fields.get("pf_payment_id")),
    amount_minor: amount,
    currency: "ZAR",
    mode,
    merchant_id: str(fields.get("merchant_id")),
  };
  const status = fields.get("payment_status");
  if (status === "COMPLETE") return { kind: "payment_succeeded", ...base };
  if (status === "FAILED")
    return { kind: "payment_failed", ...base, reason: "payment failed at PayFast" };
  if (status === "CANCELLED")
    return { kind: "payment_failed", ...base, reason: "payment cancelled at PayFast" };
  return { kind: "ignored", ...base };
}

export type ResolveHost = (host: string) => Promise<string[]>;

const defaultResolve: ResolveHost = async (host) => {
  const dns = await import("node:dns/promises");
  const [v4, v6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
  return [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ];
};

export interface PayFastProvider extends PaymentProvider {
  /** The URL the browser POSTs to, with the signed fields as its query string. */
  processUrl: string;
}

export function createPayFastProvider(
  cfg: PayFastConfig,
  fetchFn: FetchLike,
  resolveHost: ResolveHost = defaultResolve,
): PayFastProvider {
  const host = cfg.sandbox ? PAYFAST_HOSTS.sandbox : PAYFAST_HOSTS.live;
  const base = (cfg.baseOverride ?? `https://${host}`).replace(/\/+$/, "");
  const mode: Mode = cfg.sandbox ? "test" : "live";
  const allowedHosts = cfg.sandbox
    ? PAYFAST_ITN_HOSTS
    : PAYFAST_ITN_HOSTS.filter((h) => h !== PAYFAST_HOSTS.sandbox);

  async function fromPayFast(ip: string | null): Promise<"yes" | "no" | "unknown"> {
    if (cfg.checkSourceIp === false) return "yes";
    if (!ip) return "no";
    const settled = await Promise.allSettled(allowedHosts.map((h) => resolveHost(h)));
    const ips = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
    if (ips.length === 0) return "unknown"; // DNS outage: ask PayFast to retry rather than refuse
    const clean = ip.replace(/^::ffff:/, "");
    return ips.includes(clean) ? "yes" : "no";
  }

  return {
    id: "payfast",
    mode,
    merchantId: cfg.merchantId,
    processUrl: `${base}/eng/process`,

    async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
      if (req.currency !== "ZAR") throw new ProviderError("PayFast only charges ZAR");
      if (!(req.amount >= PAYFAST_MIN_RAND))
        throw new ProviderError(`PayFast needs at least R${PAYFAST_MIN_RAND.toFixed(2)}`);
      if (!req.notifyUrl) throw new ProviderError("PayFast needs a notify URL");
      const signed = signCheckoutFields(
        {
          merchant_id: cfg.merchantId,
          merchant_key: cfg.merchantKey,
          return_url: req.successUrl,
          cancel_url: req.cancelUrl,
          notify_url: req.notifyUrl,
          m_payment_id: req.transactionId,
          amount: req.amount.toFixed(2),
          // Order number only: never product names that could reveal anything clinical.
          item_name: `Cannaplug order ${req.orderNumber}`,
          custom_str1: req.orderNumber,
        },
        cfg.passphrase,
      );
      const qs = signed.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
      return { providerRef: req.transactionId, redirectUrl: `${base}/eng/process?${qs}` };
    },

    async verifyWebhook(raw, _headers, ctx): Promise<VerifyOutcome> {
      const pairs = parseItn(raw);
      if (!pairs) return { ok: false, reason: "malformed_body" };
      if (!verifyItnSignature(pairs, cfg.passphrase))
        return { ok: false, reason: "invalid_signature" };
      const source = await fromPayFast(ctx?.sourceIp ?? null);
      if (source === "unknown") return { ok: false, reason: "verification_unavailable" };
      if (source === "no") return { ok: false, reason: "verification_failed" };

      const fields = new Map(pairs);
      const paramString = pfParamString(pairs.filter(([k]) => k !== "signature"));
      let valid: string;
      try {
        const res = await fetchFn(`${base}/eng/query/validate`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: paramString,
        });
        if (!res.ok) return { ok: false, reason: "verification_unavailable" };
        valid = (await res.text()).trim();
      } catch {
        return { ok: false, reason: "verification_unavailable" };
      }
      if (valid !== "VALID") return { ok: false, reason: "verification_failed" };

      const pfId = str(fields.get("pf_payment_id"));
      const status = str(fields.get("payment_status"), 40);
      if (!pfId || !status) return { ok: false, reason: "malformed_body" };
      // Store the notification without the signature; PayFast sends no card data.
      const payload = Object.fromEntries(pairs.filter(([k]) => k !== "signature"));
      return {
        ok: true,
        event: {
          eventKey: `${pfId}:${status}`,
          eventType: `itn.${status.toLowerCase()}`,
          payload,
          facts: payfastFacts(fields, mode),
        },
      };
    },
  };
}
