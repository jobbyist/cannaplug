// Rules for the 18+ confirmation: which pages ask, who is never asked, and how long a yes is remembered.
export const AGE_GATE_KEY = "cannaplug.age.v1";
export const AGE_GATE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pages that never ask: document verification (anyone holding a document may check it), staff areas, offline, and
 * the password-reset page (only an existing, ID-checked member can arrive there from their own email).
 */
const EXEMPT = [
  /^\/verify(\/|$)/,
  /^\/admin(\/|$)/,
  /^\/doctor(\/|$)/,
  /^\/offline$/,
  /^\/reset-password$/,
];
/** Search engines and link previews read public pages without being asked. */
const CRAWLER =
  /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|linkedin|embedly|lighthouse/i;

export function ageGateNeeded(
  path: string,
  userAgent: string,
  storedAt: number | null,
  now: number,
) {
  if (EXEMPT.some((r) => r.test(path))) return false;
  if (CRAWLER.test(userAgent)) return false;
  return !(storedAt && now - storedAt >= 0 && now - storedAt < AGE_GATE_DAYS * DAY_MS);
}

/** Fired on window when someone confirms they are 18+, so things kept back until then can appear. */
export const AGE_CONFIRMED_EVENT = "cannaplug:age-confirmed";
let confirmedThisVisit = false;

/** Records a yes for this visit too (it still counts when the browser blocks storage, e.g. private mode). */
export function markAgeConfirmed() {
  confirmedThisVisit = true;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AGE_CONFIRMED_EVENT));
}

/** True when nothing on this page should be hidden behind the 18+ question any more. */
export function ageConfirmedNow(path: string): boolean {
  if (confirmedThisVisit) return true;
  try {
    const v = Number(window.localStorage.getItem(AGE_GATE_KEY));
    return !ageGateNeeded(
      path,
      navigator.userAgent,
      Number.isFinite(v) && v > 0 ? v : null,
      Date.now(),
    );
  } catch {
    return false;
  }
}
