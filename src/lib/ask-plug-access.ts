/**
 * Who sees Ask The Plug, and where (pure, shared by the server and the UI).
 *
 * WHO: verified members only: an approved ID that has not expired. Staff (budtender, manager, admin) are exempt from
 * the online ID check everywhere else, so they may use it too (useful for showing customers in store). The server
 * function checks this on every message; the UI check only decides whether to draw the button.
 *
 * WHERE: the public storefront only. Never in the member portal (/account, /member/*), the admin dashboard and till
 * (/admin*), the doctor portal, checkout and payment pages, or the standalone landing/billing pages.
 */
import { isExpired } from "@/lib/verification-logic";

export type VerificationSnapshot = {
  status?: string | null;
  document_expires_on?: string | null;
  staff_exempt?: boolean;
} | null;

export function isVerifiedMember(v: VerificationSnapshot, today: Date = new Date()): boolean {
  if (!v) return false;
  if (v.staff_exempt) return true;
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
