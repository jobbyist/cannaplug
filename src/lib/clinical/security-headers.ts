/**
 * Response hardening for the clinical routes. Applied in the server entry. The app is embedded in the
 * Lovable preview, so framing is only forbidden on the pages that handle clinical data, not globally.
 */

const SENSITIVE_EXACT = ["/doctor"];
const SENSITIVE_FOLDERS = ["/doctor/", "/verify/", "/member/", "/api/public/signatures/"];

export const isSensitivePath = (pathname: string) =>
  SENSITIVE_EXACT.includes(pathname) || SENSITIVE_FOLDERS.some((p) => pathname.startsWith(p));

export interface HeaderOptions {
  /** The request arrived over https: only then is HSTS meaningful. */
  https?: boolean;
  /** Origin of the Supabase API (REST + Realtime websocket) the browser talks to. */
  supabaseOrigin?: string | null;
  /** Allow PayFast's onsite payment window (default true). Clinical pages never take payments. */
  payfastOnsite?: boolean;
}

/**
 * PayFast onsite (engine.js) loads exactly one script, one stylesheet and one iframe per environment. Live:
 * script from www.payfast.co.za, stylesheet and iframe from payment.payfast.io. Sandbox: all from
 * sandbox.payfast.co.za. Scripts and styles are pinned to the exact file, not the whole host.
 */
export const PAYFAST_ONSITE_CSP = {
  script: [
    "https://www.payfast.co.za/onsite/engine.js",
    "https://sandbox.payfast.co.za/onsite/engine.js",
  ],
  style: [
    "https://payment.payfast.io/onsite/engine.css",
    "https://sandbox.payfast.co.za/onsite/engine.css",
  ],
  frame: ["https://payment.payfast.io", "https://sandbox.payfast.co.za"],
} as const;

/**
 * Content-Security-Policy compatible with TanStack Start SSR and the providers we use.
 *  - script-src needs 'unsafe-inline' because TanStack Start streams inline hydration scripts and the root
 *    layout carries a tiny inline theme script; everything else is first-party (no eval) except PayFast's
 *    onsite engine, allowed by exact file URL, with its stylesheet and payment iframe (PAYFAST_ONSITE_CSP).
 *  - PayPal is reached by top-level navigation, which CSP does not restrict. PayFast takes a signed form POST, so
 *    `form-action` allows our origin plus PayFast's live and sandbox hosts — and nothing else.
 *  - Browsers talk directly to Supabase (auth, REST, Realtime): connect-src allows exactly that origin.
 *  - frame-ancestors allows the Lovable editor preview and ourselves; clinical pages tighten it to 'none'.
 */
export function buildCsp(opts: HeaderOptions = {}): string {
  const supa = opts.supabaseOrigin
    ? [opts.supabaseOrigin, opts.supabaseOrigin.replace(/^http/, "ws")]
    : [];
  const pf = opts.payfastOnsite === false ? null : PAYFAST_ONSITE_CSP;
  const join = (...parts: (readonly string[] | string)[]) => parts.flat().join(" ");
  return [
    "default-src 'self'",
    join("script-src 'self' 'unsafe-inline'", pf?.script ?? []),
    join("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", pf?.style ?? []),
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src ${["'self'", "data:", "blob:", "https:", ...supa.slice(0, 1)].join(" ")}`,
    "media-src 'self' blob: https:",
    `connect-src ${["'self'", ...supa].join(" ")}`,
    pf ? join("frame-src", pf.frame) : "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
    "frame-ancestors 'self' https://*.lovable.app https://*.lovable.dev https://lovable.dev",
  ].join("; ");
}

export function applySecurityHeaders(
  pathname: string,
  headers: Headers,
  opts: HeaderOptions = {},
): void {
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy"))
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (opts.https) headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (!headers.has("Permissions-Policy"))
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)");
  if (!headers.has("Content-Security-Policy"))
    headers.set("Content-Security-Policy", buildCsp(opts));
  if (!isSensitivePath(pathname)) return;
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    buildCsp({ ...opts, payfastOnsite: false }).replace(
      /frame-ancestors[^;]*/,
      "frame-ancestors 'none'",
    ),
  );
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}
