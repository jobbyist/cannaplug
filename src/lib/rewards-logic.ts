/**
 * Loyalty rewards, referrals and usernames: pure rules shared by the browser, the server functions and the tests.
 * The database is the authority for every one of these (points, eligibility, who is eligible to refer, usernames);
 * the numbers here are what the public rewards page and the sign-up form show, and a test checks they match the
 * migration that sets them.
 */

/** Rand spent for one point. */
export const EARN_RAND_PER_POINT = 50;
/** Points a referrer earns for each friend who joins and spends the minimum. */
export const REFERRAL_POINTS = 1;
/** Rand a referred friend must spend before the referrer earns the point. */
export const REFERRAL_MIN_SPEND = 50;

export type RewardTier = {
  code: string;
  name: string;
  points: number;
  blurb: string;
  grade: string;
};
export const REWARD_TIERS: RewardTier[] = [
  {
    code: "greenhouse_free",
    name: "Free Greenhouse pre-roll or bud",
    points: 5,
    blurb: "1 free Greenhouse pre-roll, or 1 g of Greenhouse bud",
    grade: "Greenhouse",
  },
  {
    code: "indoor_free",
    name: "Free Indoor pre-roll or bud",
    points: 10,
    blurb: "1 free Entry Indoor pre-roll, or 1 g of Entry Indoor bud",
    grade: "Entry Indoor",
  },
];

/** Shown wherever points could be redeemed online. */
export const ONLINE_REDEMPTION_NOTICE =
  "Online redemption of loyalty points is coming soon. For now, redeem your points in store at the till.";

// ---- usernames -----------------------------------------------------------------------------------------------

const RESERVED = new Set([
  "admin",
  "administrator",
  "root",
  "support",
  "staff",
  "team",
  "help",
  "info",
  "owner",
  "official",
  "moderator",
  "manager",
  "budtender",
  "system",
  "null",
  "undefined",
  "cannaplug",
  "cannaplug012",
  "canna_plug",
  "api",
  "www",
  "shop",
  "store",
  "journal",
  "account",
  "checkout",
  "rewards",
  "referral",
  "login",
  "signup",
  "billing",
  "security",
]);

/** What is stored: lower case, no surrounding spaces. */
export const normaliseUsername = (raw: string): string => raw.trim().toLowerCase();

/** null when the username is well formed (the database still checks it is free). */
export function usernameProblem(
  raw: string,
  opts: { allowImported?: boolean } = {},
): string | null {
  const v = normaliseUsername(raw);
  if (!v) return "Choose a username.";
  // Usernames brought over from the previous platform look like first.last (dots, up to 32 characters). The
  // sign-up form accepts that shape; the database decides whether it is the member's own.
  if (!(opts.allowImported ? /^[a-z0-9_.]{3,32}$/ : /^[a-z0-9_]{3,20}$/).test(v))
    return "A username is 3 to 20 letters, numbers or underscores, with no spaces.";
  if (RESERVED.has(v)) return "That username is not available. Try another.";
  return null;
}

/** A member's referral link: it opens the sign-up form with their username filled in as the referral code. */
export const referralLink = (origin: string, username: string): string =>
  `${origin.replace(/\/$/, "")}/account?ref=${encodeURIComponent(normaliseUsername(username))}`;

export const referralShareText = (link: string, username: string): string =>
  `Join me on CannaPlug! Sign up with my link (or enter the code ${normaliseUsername(username)}) and we both earn loyalty points: ${link}`;

/** `?ref=` from the address, cleaned up; "" when missing or not a plausible code. */
export function referralFromSearch(search: string): string {
  const raw = new URLSearchParams(search).get("ref") ?? "";
  const v = raw.trim().toLowerCase();
  return /^[a-z0-9_.-]{3,32}$/.test(v) ? v : "";
}

/** Points still needed for the next reward the member cannot yet claim, or null when they can claim every reward. */
export function nextReward(
  points: number,
  tiers: { points: number; name: string }[] = REWARD_TIERS,
) {
  const sorted = [...tiers].sort((a, b) => a.points - b.points);
  const next = sorted.find((t) => t.points > points);
  return next ? { name: next.name, pointsToGo: next.points - points } : null;
}

/** Rand still to spend for the next point. */
export const randToNextPoint = (spendSinceLastPoint: number) =>
  Math.max(0, EARN_RAND_PER_POINT - (spendSinceLastPoint % EARN_RAND_PER_POINT));
