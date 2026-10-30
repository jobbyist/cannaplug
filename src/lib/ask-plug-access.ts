/**
 * Where Ask The Plug appears (pure, shared by the server and the UI).
 *
 * WHO: everyone (owner's decision, 30 Oct 2026, replacing the earlier verified-members-and-admins rule). Signed-in
 * members get the full daily chat allowance and the one-time launch announcement; signed-out visitors get a much
 * smaller chat allowance and a tighter quiz cap, enforced on the server (src/lib/ai/quota.ts, plug-match.server.ts),
 * so opening it up cannot exhaust Gemini's free tier. Checking out still needs an account and a verified ID.
 *
 * WHERE: the public storefront only. Never in the member portal (/account, /member/*), the admin dashboard and till
 * (/admin*), the doctor portal, checkout and payment pages, or the standalone landing/billing pages.
 */
import { isExpired } from "@/lib/verification-logic";

export type VerificationSnapshot = {
  status?: string | null;
  document_expires_on?: string | null;
  /** The account holds the admin role. */
  admin?: boolean;
} | null;

export function isVerifiedMember(v: VerificationSnapshot, today: Date = new Date()): boolean {
  if (!v) return false;
  if (v.admin) return true;
  return v.status === "verified" && !isExpired(v.document_expires_on, today);
}

/** Pages where the launcher may appear. Everything else (portal, admin, checkout, payments…) never shows it. */
const STOREFRONT_PREFIXES = [
  "/shop",
  "/about",
  "/events",
  "/calendar",
  "/journal",
  "/rewards",
  "/faq",
  "/gallery",
  "/delivery-policy",
  "/privacy-policy",
  "/refund-policy",
  "/terms-of-service",
] as const;

export function isStorefrontPath(pathname: string): boolean {
  const path = (pathname || "/").split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  if (path === "/") return true;
  return STOREFRONT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** The intro modal also greets members on their account page (where they land after signing in). */
export function isIntroPath(pathname: string): boolean {
  const path = (pathname || "/").split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  return isStorefrontPath(path) || path === "/account";
}

/** Feature keys stored in member_feature_seen (see migration 20261031002000_member_feature_seen). */
export const INTRO_FEATURE = "ask_the_plug_intro";
export const PREVIEW_FEATURE = "ask_the_plug_preview";
