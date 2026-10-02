/**
 * Free-tier protection for the Gemini API. Google applies RPM / TPM / RPD limits per PROJECT and resets the daily
 * quota at midnight Pacific time, so the counters here use the same clock. Defaults are deliberately below the
 * free-tier numbers for 2.5 Flash (Google publishes the live figures in AI Studio) and are overridable by env:
 *   GEMINI_RPM_LIMIT   requests/minute across the whole site      (default 8)
 *   GEMINI_RPD_LIMIT   requests/day across the whole site         (default 180)
 *   CHAT_RPD_LIMIT     of which the chatbot may use                (default 140)  -> the rest is reserved for the Journal pipeline
 * Per visitor: 12 messages/hour per hashed IP and 40/session.
 */
export interface QuotaDb {
  take(bucket: string, limit: number, ttlSeconds: number): Promise<boolean>;
}

export interface QuotaConfig {
  rpm: number;
  rpd: number;
  chatRpd: number;
  ipPerHour: number;
  sessionTotal: number;
}

export const quotaConfig = (env: Record<string, string | undefined>): QuotaConfig => {
  const n = (v: string | undefined, d: number) =>
    v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d;
  const rpd = n(env["GEMINI_RPD_LIMIT"], 180);
  return {
    rpm: n(env["GEMINI_RPM_LIMIT"], 8),
    rpd,
    chatRpd: Math.min(n(env["CHAT_RPD_LIMIT"], 140), rpd),
    ipPerHour: 12,
    sessionTotal: 40,
  };
};

/** The calendar date in America/Los_Angeles, which is when Google's daily quota rolls over. */
export const pacificDate = (now: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

export type QuotaVerdict =
  | { ok: true }
  | { ok: false; reason: "visitor" | "session" | "busy" | "daily"; retryAfterMinutes: number };

/**
 * Checks, in order: visitor (IP), session, then the shared Gemini budget. A denial counts nothing further, so a
 * flood from one visitor cannot spend the site's quota.
 */
export async function takeChatQuota(
  db: QuotaDb,
  cfg: QuotaConfig,
  who: { sessionId: string; ipHash: string | null },
  now = Date.now(),
): Promise<QuotaVerdict> {
  const hour = Math.floor(now / 3_600_000);
  const minute = Math.floor(now / 60_000);
  const minsToHour = Math.max(1, Math.ceil(((hour + 1) * 3_600_000 - now) / 60_000));
  if (who.ipHash && !(await db.take(`chat:ip:${who.ipHash}:${hour}`, cfg.ipPerHour, 2 * 3600))) {
    return { ok: false, reason: "visitor", retryAfterMinutes: minsToHour };
  }
  if (!(await db.take(`chat:session:${who.sessionId}`, cfg.sessionTotal, 24 * 3600))) {
    return { ok: false, reason: "session", retryAfterMinutes: 24 * 60 };
  }
  // Shared budget, cheapest-to-burn first: the per-minute slot is taken BEFORE the daily counters so a "busy"
  // refusal never spends daily budget; a daily refusal costs at most one minute slot.
  if (!(await db.take(`gemini:rpm:${minute}`, cfg.rpm, 180))) {
    return { ok: false, reason: "busy", retryAfterMinutes: 1 };
  }
  const day = pacificDate(now);
  if (!(await db.take(`gemini:rpd:chat:${day}`, cfg.chatRpd, 2 * 86400))) {
    return { ok: false, reason: "daily", retryAfterMinutes: 60 };
  }
  if (!(await db.take(`gemini:rpd:${day}`, cfg.rpd, 2 * 86400))) {
    return { ok: false, reason: "daily", retryAfterMinutes: 60 };
  }
  return { ok: true };
}

/** For background jobs (Journal pipeline): spend only from the reserved share of the daily budget. */
export async function takeJobQuota(
  db: QuotaDb,
  cfg: QuotaConfig,
  now = Date.now(),
): Promise<boolean> {
  const day = pacificDate(now);
  const reserved = Math.max(0, cfg.rpd - cfg.chatRpd);
  if (reserved < 1) return false;
  if (!(await db.take(`gemini:rpm:${Math.floor(now / 60_000)}`, cfg.rpm, 180))) return false;
  if (!(await db.take(`gemini:rpd:job:${day}`, reserved, 2 * 86400))) return false;
  return db.take(`gemini:rpd:${day}`, cfg.rpd, 2 * 86400);
}

export const quotaMessage = (v: Extract<QuotaVerdict, { ok: false }>): string => {
  switch (v.reason) {
    case "visitor":
      return `You're sending messages quickly. Please try again in about ${v.retryAfterMinutes} minute${v.retryAfterMinutes === 1 ? "" : "s"}.`;
    case "session":
      return "You've reached the chat limit for today. For more help, call +27 10 123 4567, email info@cannaplug012.co.za or pop into the shop.";
    case "busy":
      return "The assistant is a little busy right now. Please try again in a minute.";
    case "daily":
      return "Our assistant has reached its limit for now and will be back shortly. For help right away, call +27 10 123 4567 or email info@cannaplug012.co.za.";
  }
};
