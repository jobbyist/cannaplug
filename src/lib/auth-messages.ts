import { SITE_URL } from "@/lib/site";

/** Where Supabase sends people back to after a confirmation or reset email: always the live site. */
export const AUTH_REDIRECT = `${SITE_URL}/account`;

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
        "Please confirm your email first: open the link we emailed you. Can't find it? Check spam, or send a new link below.",
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
