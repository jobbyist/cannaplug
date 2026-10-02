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
}

/**
 * Content-Security-Policy compatible with TanStack Start SSR and the providers we use.
 *  - script-src needs 'unsafe-inline' because TanStack Start streams inline hydration scripts and the root
 *    layout carries a tiny inline theme script; everything else is first-party only (no eval, no remote scripts).
 *  - Payment pages are reached by top-level navigation (Yoco / PayPal hosted checkout), which CSP does not
 *    restrict, so no provider origin is needed here; `form-action 'self'` keeps forms on our origin.
 *  - Browsers talk directly to Supabase (auth, REST, Realtime): connect-src allows exactly that origin.
 *  - frame-ancestors allows the Lovable editor preview and ourselves; clinical pages tighten it to 'none'.
 */
export function buildCsp(opts: HeaderOptions = {}): string {
  const supa = opts.supabaseOrigin
    ? [opts.supabaseOrigin, opts.supabaseOrigin.replace(/^http/, "ws")]
    : [];
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src ${["'self'", "data:", "blob:", "https:", ...supa.slice(0, 1)].join(" ")}`,
    "media-src 'self' blob: https:",
    `connect-src ${["'self'", ...supa].join(" ")}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
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
    buildCsp(opts).replace(/frame-ancestors[^;]*/, "frame-ancestors 'none'"),
  );
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}
