/**
 * Where to send someone after they sign in or sign up. Only paths on this site are accepted, so a crafted link
 * (`?redirect=https://evil.example`, `//evil.example`, `/\evil.example`) can never send a member elsewhere.
 * Returns null when there is nothing safe to go back to.
 */
export function safeRedirect(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim();
  if (!path || path.length > 300) return null;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null;
  if ([...path].some((c) => c.charCodeAt(0) < 32) || /^\/[a-z][a-z0-9+.-]*:/i.test(path))
    return null;
  // Going "back" to the sign-in page or the reset page would loop.
  if (/^\/(account|reset-password)(?:[/?#]|$)/.test(path)) return null;
  return path;
}

/** The redirect carried in a page's query string, if it is safe. */
export function redirectFromSearch(search: string): string | null {
  return safeRedirect(new URLSearchParams(search).get("redirect"));
}

/** A link to the sign-in page that comes back to `path` afterwards. */
export function signInHref(path: string, mode?: "signup"): string {
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  const back = safeRedirect(path);
  if (back) params.set("redirect", back);
  const q = params.toString();
  return q ? `/account?${q}` : "/account";
}
