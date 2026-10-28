// Rules for the 18+ confirmation: which pages ask, who is never asked, and how long a yes is remembered.
export const AGE_GATE_KEY = "cannaplug.age.v1";
export const AGE_GATE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pages that never ask: document verification (anyone holding a document may check it), staff areas, offline. */
const EXEMPT = [/^\/verify(\/|$)/, /^\/admin(\/|$)/, /^\/doctor(\/|$)/, /^\/offline$/];
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
