/**
 * Response hardening for the clinical routes. Applied in the server entry. The app is embedded in the
 * Lovable preview, so framing is only forbidden on the pages that handle clinical data, not globally.
 */

const SENSITIVE_EXACT = ["/doctor"];
const SENSITIVE_FOLDERS = ["/doctor/", "/verify/", "/member/", "/api/public/signatures/"];

export const isSensitivePath = (pathname: string) =>
  SENSITIVE_EXACT.includes(pathname) || SENSITIVE_FOLDERS.some((p) => pathname.startsWith(p));

export function applySecurityHeaders(pathname: string, headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Referrer-Policy"))
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!isSensitivePath(pathname)) return;
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}
