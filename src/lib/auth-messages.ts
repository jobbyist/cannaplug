import { SITE_URL } from "@/lib/site";

/** Where Supabase sends people back to after a sign-up email: always the live site. */
export const AUTH_REDIRECT = `${SITE_URL}/account`;

/**
 * Where a password-reset email link lands: a page that only does one thing (choose a new password), so the link
 * works even if Supabase drops a query string, and nothing else (age gate, tour, popups) gets in the way.
 */
export const RESET_REDIRECT = `${SITE_URL}/reset-password`;

/** Left by useAuth when it moves a recovery link from another page to /reset-password (this tab only). */
export const RECOVERY_MARKER = "cannaplug.recovery";

export function markRecovery() {
  try {
    window.sessionStorage.setItem(RECOVERY_MARKER, String(Date.now()));
  } catch {
    /* storage blocked: the reset page then asks the person to use their account settings */
  }
}

/** True once, within 10 minutes of a recovery hand-over in this tab; the marker is removed when read. */
export function takeRecoveryMarker(now = Date.now()): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(RECOVERY_MARKER));
    window.sessionStorage.removeItem(RECOVERY_MARKER);
    return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < 10 * 60_000;
  } catch {
    return false;
  }
}

/**
 * Supabase reports a bad email link in the URL (`#error=access_denied&error_code=otp_expired&...`, or the same
 * in the query string). Returns words a member can act on, or null when the link carried no error.
 */
export function recoveryLinkProblem(hash: string, search: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const query = new URLSearchParams(search);
  const code = params.get("error_code") ?? query.get("error_code");
  const error = params.get("error") ?? query.get("error");
  if (!code && !error) return null;
  if (code === "otp_expired" || /expired|invalid/i.test(params.get("error_description") ?? ""))
    return "This reset link has expired or has already been used. Links work once, for one hour. Send yourself a new one below.";
  return "This reset link didn't work. Send yourself a new one below.";
}

export type AuthProblem = {
  message: string;
  kind: "rate_limited" | "unconfirmed" | "credentials" | "other";
};

/**
 * Supabase Auth errors in words a customer can act on. Never says whether an account exists.
 * "email rate limit exceeded" means Supabase could not send the email (its built-in mailer allows only a
 * few emails an hour until custom SMTP is set up); it is not the customer's fault.
 */
export function authProblem(raw: string): AuthProblem {
  if (/rate limit|over_email_send_rate_limit|too many/i.test(raw))
    return {
      kind: "rate_limited",
      message:
        "We couldn't send the email just now because too many were sent in a short time. Please try again in a few minutes. If it keeps happening, contact us on +27 68 291 2107.",
    };
  const wait = /only request this after (\d+) seconds/i.exec(raw);
  if (wait)
    return {
      kind: "rate_limited",
      message: `Please wait ${wait[1]} seconds before trying again.`,
    };
  if (/email not confirmed/i.test(raw))
    return {
      kind: "unconfirmed",
      message:
        "We couldn't sign you in to this account yet. Please contact us on +27 68 291 2107 and we'll sort it out.",
    };
  if (/invalid login credentials/i.test(raw))
    return {
      kind: "credentials",
      message: "That email and password don't match. Check them, or use Forgot password.",
    };
  if (/already registered|already exists/i.test(raw))
    return {
      kind: "other",
      message: "This email already has an account. Sign in instead, or use Forgot password.",
    };
  return { kind: "other", message: raw || "Something went wrong. Please try again." };
}
