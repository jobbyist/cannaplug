import { goToCheckout } from "./redirect";

/**
 * PayFast onsite payments in the browser (developers.payfast.co.za → "Onsite Payments (Beta)").
 *
 * The server hands us a one-time `uuid` and the exact engine URL. We load PayFast's engine.js from one of the
 * two official URLs only, then call `window.payfast_do_onsite_payment({uuid}, callback)`. PayFast's script
 * opens PayFast's own payment page in an iframe over ours; card details are typed there, never into our page.
 *
 * The callback says only "the window closed after success" (true) or "the member closed it" (false). Neither
 * is proof of payment: the page goes on to ask the server, which only reports "paid" after a verified ITN.
 */
export const PAYFAST_ENGINE_ALLOWLIST = [
  "https://www.payfast.co.za/onsite/engine.js",
  "https://sandbox.payfast.co.za/onsite/engine.js",
] as const;

type OnsiteFn = (opts: { uuid: string }, callback: (result: boolean) => void) => void;
type PayFastWindow = Window & { payfast_do_onsite_payment?: OnsiteFn };

export const isPayFastEngineUrl = (url: string): boolean =>
  (PAYFAST_ENGINE_ALLOWLIST as readonly string[]).includes(url);

const loads = new Map<string, Promise<OnsiteFn>>();

/** Loads PayFast's engine once per URL. Rejects for any other URL, on a load error, or after `timeoutMs`. */
export function loadPayFastEngine(
  url: string,
  doc: Document = document,
  timeoutMs = 15_000,
): Promise<OnsiteFn> {
  if (!isPayFastEngineUrl(url)) return Promise.reject(new Error("not PayFast's engine"));
  const win = doc.defaultView as PayFastWindow | null;
  const ready = win?.payfast_do_onsite_payment;
  if (ready) return Promise.resolve(ready);
  const pending = loads.get(url);
  if (pending) return pending;

  const p = new Promise<OnsiteFn>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = url;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    const timer = setTimeout(() => fail(new Error("PayFast took too long to load")), timeoutMs);
    const fail = (err: Error) => {
      clearTimeout(timer);
      loads.delete(url);
      script.remove();
      reject(err);
    };
    script.onload = () => {
      clearTimeout(timer);
      const fn = (doc.defaultView as PayFastWindow | null)?.payfast_do_onsite_payment;
      if (typeof fn === "function") resolve(fn);
      else fail(new Error("PayFast's payment window is unavailable"));
    };
    script.onerror = () => fail(new Error("PayFast could not be reached"));
    doc.head.appendChild(script);
  });
  loads.set(url, p);
  return p;
}

/** Opens PayFast's payment window; resolves with PayFast's callback value once it closes. */
export async function openPayFastOnsite(
  session: { uuid: string; engineUrl: string },
  doc: Document = document,
): Promise<boolean> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(session.uuid)) throw new Error("invalid payment identifier");
  const open = await loadPayFastEngine(session.engineUrl, doc);
  return new Promise<boolean>((resolve) => {
    open({ uuid: session.uuid }, (result) => resolve(result === true));
  });
}

/** Where every finished attempt goes: a page that asks the server, which only says "paid" after a verified ITN. */
export const returnUrl = (
  orderId: string,
  method: "card" | "paypal",
  result: "success" | "cancelled",
) =>
  `/payment/return?order=${encodeURIComponent(orderId)}&provider=${method === "card" ? "payfast" : "paypal"}&result=${result}`;

export type PresentOutcome = "completed" | "closed" | "redirected";

/**
 * Takes the member to payment: PayFast's window on this page when the server prepared one, otherwise (or if
 * PayFast's script cannot load) the provider's hosted page for the same transaction.
 */
export async function presentPayment(
  started: { redirectUrl: string; onsite: { uuid: string; engineUrl: string } | null },
  hooks: { onWindowOpen?(): void } = {},
): Promise<PresentOutcome> {
  if (started.onsite) {
    let opened: Promise<boolean> | null = null;
    try {
      await loadPayFastEngine(started.onsite.engineUrl);
      hooks.onWindowOpen?.();
      opened = openPayFastOnsite(started.onsite);
    } catch {
      opened = null; // fall through to the hosted page
    }
    if (opened) return (await opened) ? "completed" : "closed";
  }
  goToCheckout(started.redirectUrl);
  return "redirected";
}
