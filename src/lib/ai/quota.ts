/**
 * Free-tier protection for Ask The Plug. Counters live in the database (`ai_quota_take`, atomic, see
 * 20261008090000 roles_and_chat_rate_limits) and use Google's clock: daily buckets roll over at midnight Pacific.
 *
 * Order of checks for one message (a refusal stops the chain, so nothing further is spent):
 *   1. the member's own daily messages          CHAT_MEMBER_RPD        (default 25)
 *   2. the member's own daily deep matches       PLUG_MEMBER_MATCH_RPD  (default 3; "Find my match" only)
 *   3. per hashed IP per hour                    30
 *   4. per chat session                          40
 *   5. a per-model slot (RPM, then RPD), taken right before each model is called: see plug-models.ts.
 * A member who is refused at 1–4 never reaches Gemini; a busy model is skipped for the next one in the ladder.
 */
import { SITE_FACTS } from "./chat-prompt";
import type { PlugModel } from "./plug-models";

export interface QuotaDb {
  take(bucket: string, limit: number, ttlSeconds: number): Promise<boolean>;
  /** Current count of a bucket (0 when absent). Used only for display. */
  count?(bucket: string): Promise<number>;
}

export interface QuotaConfig {
  memberPerDay: number;
  memberMatchesPerDay: number;
  ipPerHour: number;
  sessionTotal: number;
}

const n = (v: string | undefined, d: number) =>
  v && Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d;

export const quotaConfig = (env: Record<string, string | undefined>): QuotaConfig => ({
  memberPerDay: n(env["CHAT_MEMBER_RPD"], 25),
  memberMatchesPerDay: n(env["PLUG_MEMBER_MATCH_RPD"], 3),
  ipPerHour: 30,
  sessionTotal: 40,
});

/** The calendar date in America/Los_Angeles, which is when Google's daily quota rolls over. */
export const pacificDate = (now: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));

/** The next midnight in America/Los_Angeles (always on a whole UTC hour), when every daily bucket resets. */
export function nextPacificMidnight(now: number): number {
  const today = pacificDate(now);
  let t = Math.ceil(now / 3_600_000) * 3_600_000;
  while (pacificDate(t) === today) t += 3_600_000;
  return t;
}

export const memberBucket = (userId: string, now: number) =>
  `chat:member:${userId}:${pacificDate(now)}`;
export const matchBucket = (userId: string, now: number) =>
  `plug:match:${userId}:${pacificDate(now)}`;
export const modelMinuteBucket = (model: string, now: number) =>
  `gemini:${model}:rpm:${Math.floor(now / 60_000)}`;
export const modelDayBucket = (model: string, now: number) =>
  `gemini:${model}:rpd:${pacificDate(now)}`;

export type QuotaVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "member" | "matches" | "visitor" | "session" | "busy" | "daily";
      retryAfterMinutes: number;
      resetsAt?: number;
    };

/** The member-side checks (1–4 above). Nothing is spent on Gemini here. */
export async function takeMemberQuota(
  db: QuotaDb,
  cfg: QuotaConfig,
  who: { sessionId: string; ipHash: string | null; userId: string },
  mode: "chat" | "match",
  now = Date.now(),
): Promise<QuotaVerdict> {
  const resetsAt = nextPacificMidnight(now);
  const untilReset = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  if (!(await db.take(memberBucket(who.userId, now), cfg.memberPerDay, 2 * 86400))) {
    return { ok: false, reason: "member", retryAfterMinutes: untilReset, resetsAt };
  }
  if (
    mode === "match" &&
    !(await db.take(matchBucket(who.userId, now), cfg.memberMatchesPerDay, 2 * 86400))
  ) {
    return { ok: false, reason: "matches", retryAfterMinutes: untilReset, resetsAt };
  }
  const hour = Math.floor(now / 3_600_000);
  const minsToHour = Math.max(1, Math.ceil(((hour + 1) * 3_600_000 - now) / 60_000));
  if (who.ipHash && !(await db.take(`chat:ip:${who.ipHash}:${hour}`, cfg.ipPerHour, 2 * 3600))) {
    return { ok: false, reason: "visitor", retryAfterMinutes: minsToHour };
  }
  if (!(await db.take(`chat:session:${who.sessionId}`, cfg.sessionTotal, 24 * 3600))) {
    return { ok: false, reason: "session", retryAfterMinutes: 24 * 60 };
  }
  return { ok: true };
}

/**
 * One request slot on one model: the per-minute slot first, then the daily one, so a "busy" refusal never spends
 * daily budget. Returns why it was refused so the ladder can move on (and report the right message if all refuse).
 */
export async function takeModelSlot(
  db: QuotaDb,
  model: Pick<PlugModel, "id" | "rpm" | "rpd">,
  now = Date.now(),
): Promise<"ok" | "busy" | "daily"> {
  if (!(await db.take(modelMinuteBucket(model.id, now), model.rpm, 180))) return "busy";
  if (!(await db.take(modelDayBucket(model.id, now), model.rpd, 2 * 86400))) return "daily";
  return "ok";
}

export type Allowance = {
  limit: number;
  remaining: number;
  matchLimit: number;
  matchesRemaining: number;
  resetsAt: string;
};

/** What a member has left today, for the chat panel. */
export async function memberAllowance(
  db: QuotaDb,
  cfg: QuotaConfig,
  userId: string,
  now = Date.now(),
): Promise<Allowance> {
  const [used, matches] = await Promise.all([
    db.count?.(memberBucket(userId, now)) ?? 0,
    db.count?.(matchBucket(userId, now)) ?? 0,
  ]);
  return {
    limit: cfg.memberPerDay,
    remaining: Math.max(0, cfg.memberPerDay - (used ?? 0)),
    matchLimit: cfg.memberMatchesPerDay,
    matchesRemaining: Math.max(0, cfg.memberMatchesPerDay - (matches ?? 0)),
    resetsAt: new Date(nextPacificMidnight(now)).toISOString(),
  };
}

export const sastTime = (ms: number) =>
  new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));

export const quotaMessage = (v: Extract<QuotaVerdict, { ok: false }>): string => {
  const reset = sastTime(v.resetsAt ?? Date.now() + v.retryAfterMinutes * 60_000);
  switch (v.reason) {
    case "member":
      return `That's all your Ask The Plug messages for today. They reset at ${reset} (SA time). Need help now? Call ${SITE_FACTS.phone} or pop into the shop.`;
    case "matches":
      return `You've used today's deep matches. They reset at ${reset} (SA time), but you can keep chatting with me in the meantime.`;
    case "visitor":
      return `You're sending messages quickly. Please try again in about ${v.retryAfterMinutes} minute${v.retryAfterMinutes === 1 ? "" : "s"}.`;
    case "session":
      return `This chat has reached its limit for today. Start fresh tomorrow, or call ${SITE_FACTS.phone} and the team will help.`;
    case "busy":
      return "The Plug is helping a lot of people right now. Give it a minute and try again.";
    case "daily":
      return `The Plug is resting until later today. For help right away, call ${SITE_FACTS.phone} or email ${SITE_FACTS.email}.`;
  }
};

/**
 * The Journal pipeline's own guard. It runs on gemini-2.5-flash (NEWSROOM_MODEL), which Google limits separately from
 * the Ask The Plug models, so it keeps the old settings as a per-model guard: GEMINI_RPM_LIMIT (8), GEMINI_RPD_LIMIT (180).
 */
export const jobModelConfig = (
  env: Record<string, string | undefined>,
  model = "gemini-2.5-flash",
): Pick<PlugModel, "id" | "rpm" | "rpd"> => ({
  id: model,
  rpm: n(env["GEMINI_RPM_LIMIT"], 8),
  rpd: n(env["GEMINI_RPD_LIMIT"], 180),
});

/** For background jobs (Journal pipeline): one request slot on the job's model. */
export async function takeJobQuota(
  db: QuotaDb,
  model: Pick<PlugModel, "id" | "rpm" | "rpd">,
  now = Date.now(),
): Promise<boolean> {
  return (await takeModelSlot(db, model, now)) === "ok";
}
