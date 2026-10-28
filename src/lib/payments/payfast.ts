import { createHash, timingSafeEqual } from "node:crypto";
import {
  ProviderError,
  type CheckoutRequest,
  type CheckoutSession,
  type FetchLike,
  type Mode,
  type OnsiteBuyer,
  type OnsiteSession,
  type PaymentProvider,
  type VerifiedFacts,
  type VerifyOutcome,
} from "./provider";

/**
 * PayFast (ZAR card, Instant EFT and the other methods PayFast offers on its hosted page).
 *
 * Checkout, two officially documented ways (developers.payfast.co.za, "Custom Integration" and
 * "Onsite Payments (Beta)"):
 *   - hosted: the member's browser POSTs a signed form to {host}/eng/process and leaves our site;
 *   - onsite: WE post the same signed fields server-to-server to {host}/onsite/process, PayFast answers
 *     {"uuid": "..."}, and PayFast's engine.js opens PayFast's own payment window (an iframe PayFast serves)
 *     over our checkout. Card numbers are typed into PayFast's page, never ours. Onsite needs HTTPS, an
 *     `email_address`, the merchant account enabled for it, and supports card, Instant EFT and Masterpass only.
 *     It is opt-in (`PAYFAST_ONSITE=true`); any failure falls back to the hosted page.
 * The signature is
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
/** PayFast's onsite payment engine, per environment. The browser loads nothing else from PayFast. */
export const PAYFAST_ENGINE_URLS = {
  live: "https://www.payfast.co.za/onsite/engine.js",
  sandbox: "https://sandbox.payfast.co.za/onsite/engine.js",
} as const;
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
  /** Offer PayFast's onsite payment window instead of sending the member to PayFast's site. */
  onsite?: boolean;
  /** Test-only: point checkout and validation at a mock server. */
  baseOverride?: string | undefined;
  /** Default true. Only tests turn the source-IP check off. */
  checkSourceIp?: boolean;
}

/** "live" (also unset, "production", "prod"), "sandbox", or null for anything else. */
const payfastEnvName = (v: string | undefined): "live" | "sandbox" | null => {
  const n = (v ?? "").trim().toLowerCase();
  if (n === "" || n === "live" || n === "production" || n === "prod") return "live";
  return n === "sandbox" ? "sandbox" : null;
};
const truthy = (v: string | undefined) => /^(true|1|on|yes)$/i.test(v?.trim() ?? "");
const falsy = (v: string | undefined) => /^(false|0|off|no)?$/i.test(v?.trim() ?? "");

export function payfastFromEnv(env: Record<string, string | undefined>): PayFastConfig | null {
  const merchantId = env["PAYFAST_MERCHANT_ID"]?.trim();
  const merchantKey = env["PAYFAST_MERCHANT_KEY"]?.trim();
  if (!merchantId || !merchantKey || !/^[0-9]{5,12}$/.test(merchantId)) return null;
  const envName = payfastEnvName(env["PAYFAST_ENV"]);
  // An unrecognised environment is a misconfiguration, never a silent guess at live or sandbox.
  if (!envName) return null;
  // Tests only: a local mock (plain http on localhost). Never honoured for any other host.
  const override = env["PAYFAST_API_BASE"]?.trim();
  const local = !!override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(override);
  return {
    merchantId,
    merchantKey,
    passphrase: env["PAYFAST_PASSPHRASE"]?.trim() || null,
    sandbox: envName === "sandbox",
    onsite: truthy(env["PAYFAST_ONSITE"]),
    ...(local ? { baseOverride: override, checkSourceIp: false } : {}),
  };
}

/**
 * What is wrong with the PayFast settings, in words an operator can act on. Empty when PayFast is either
 * fully configured or deliberately not configured at all. Never includes a secret value.
 */
export function payfastConfigProblems(env: Record<string, string | undefined>): string[] {
  const id = env["PAYFAST_MERCHANT_ID"]?.trim();
  const key = env["PAYFAST_MERCHANT_KEY"]?.trim();
  const touched = ["PAYFAST_MERCHANT_ID", "PAYFAST_MERCHANT_KEY", "PAYFAST_PASSPHRASE"].some(
    (k) => !!env[k]?.trim(),
  );
  const out: string[] = [];
  if (touched && !id) out.push("PAYFAST_MERCHANT_ID is missing: PayFast is switched off.");
  if (id && !/^[0-9]{5,12}$/.test(id))
    out.push("PAYFAST_MERCHANT_ID must be the numeric merchant id from PayFast: PayFast is off.");
  if (touched && !key) out.push("PAYFAST_MERCHANT_KEY is missing: PayFast is switched off.");
  if (!payfastEnvName(env["PAYFAST_ENV"]))
    out.push(`PAYFAST_ENV must be "live" or "sandbox": PayFast is switched off until it is.`);
  if (id && key && !env["PAYFAST_PASSPHRASE"]?.trim())
    out.push(
      "PAYFAST_PASSPHRASE is not set: PayFast signatures are then made without one, which only works if no passphrase is set in PayFast → Settings → Developer settings.",
    );
  const onsite = env["PAYFAST_ONSITE"];
  if (!truthy(onsite) && !falsy(onsite))
    out.push('PAYFAST_ONSITE must be "true" or "false": the onsite payment window is off.');
  return out;
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
  /** Whether the onsite payment window is switched on (PAYFAST_ONSITE). */
  onsite: boolean;
  createOnsitePayment(req: CheckoutRequest, buyer: OnsiteBuyer): Promise<OnsiteSession>;
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

  const engineUrl = cfg.sandbox ? PAYFAST_ENGINE_URLS.sandbox : PAYFAST_ENGINE_URLS.live;

  /** The signed fields for one transaction: the same for the hosted page and the onsite window. */
  function signedCheckout(
    req: CheckoutRequest,
    buyer: { email_address?: string } = {},
  ): [string, string][] {
    if (req.currency !== "ZAR") throw new ProviderError("PayFast only charges ZAR");
    if (!(req.amount >= PAYFAST_MIN_RAND))
      throw new ProviderError(`PayFast needs at least R${PAYFAST_MIN_RAND.toFixed(2)}`);
    if (!req.notifyUrl) throw new ProviderError("PayFast needs a notify URL");
    return signCheckoutFields(
      {
        merchant_id: cfg.merchantId,
        merchant_key: cfg.merchantKey,
        return_url: req.successUrl,
        cancel_url: req.cancelUrl,
        notify_url: req.notifyUrl,
        ...buyer,
        m_payment_id: req.transactionId,
        amount: req.amount.toFixed(2),
        // Order number only: never product names that could reveal anything clinical.
        item_name: `Cannaplug order ${req.orderNumber}`,
        custom_str1: req.orderNumber,
      },
      cfg.passphrase,
    );
  }

  return {
    id: "payfast",
    mode,
    merchantId: cfg.merchantId,
    processUrl: `${base}/eng/process`,
    onsite: !!cfg.onsite,

    async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
      const signed = signedCheckout(req);
      const qs = signed.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
      return { providerRef: req.transactionId, redirectUrl: `${base}/eng/process?${qs}` };
    },

    async createOnsitePayment(req: CheckoutRequest, buyer: OnsiteBuyer): Promise<OnsiteSession> {
      if (!cfg.onsite) throw new ProviderError("PayFast onsite payments are not enabled");
      const email = buyer.email?.trim() ?? "";
      // PayFast requires the buyer's email for onsite (it is their PayFast login and receipt address).
      if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || email.length > 100)
        throw new ProviderError("PayFast onsite needs the member's email address");
      const signed = signedCheckout(req, { email_address: email });
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetchFn(`${base}/onsite/process`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: pfParamString(signed),
        });
      } catch {
        throw new ProviderError("PayFast onsite is unreachable");
      }
      // PayFast's error bodies can echo submitted fields; never surface them.
      if (!res.ok) throw new ProviderError("PayFast refused the onsite payment", res.status);
      let uuid: unknown;
      try {
        uuid = (JSON.parse(await res.text()) as { uuid?: unknown }).uuid;
      } catch {
        throw new ProviderError("PayFast onsite answered with something unexpected");
      }
      // The identifier ends up in PayFast's iframe URL: accept only a plain token.
      if (typeof uuid !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(uuid))
        throw new ProviderError("PayFast onsite answered without a payment identifier");
      return { uuid, engineUrl };
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
