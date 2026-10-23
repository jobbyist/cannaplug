import { SITE_FACTS } from "./chat-prompt";
import {
  generateWithRetry,
  GeminiError,
  GEMINI_CHAT_MODEL,
  GEMINI_FALLBACK_MODEL,
  type FetchLike,
  type Turn,
} from "./gemini";
import {
  memberAllowance,
  quotaMessage,
  siteBudgetUsed,
  takeChatQuota,
  type QuotaConfig,
  type QuotaDb,
} from "./quota";

export type Allowance = { limit: number; remaining: number; resetsAt: string };
export type ChatReply =
  | { ok: true; reply: string; allowance?: Allowance }
  | {
      ok: false;
      error: string;
      limited?: boolean;
      signInRequired?: boolean;
      allowance?: Allowance;
    };

export const SIGN_IN_REQUIRED = "sign_in_required";
/** Above this share of the site's daily Gemini budget, chat answers with the lighter model. */
export const FALLBACK_BUDGET_SHARE = 0.8;

/** Removes markdown emphasis/heading marks so replies read like a natural text message. */
export function toPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, "").trim())
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^\s*[*+]\s+/gm, "• ")
    .replace(/#/g, "")
    .replace(/\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ChatDeps {
  quotaDb: QuotaDb;
  quota: QuotaConfig;
  fetch: FetchLike;
  geminiKey: string | null;
  /** Primary chat model (GEMINI_CHAT_MODEL, default gemini-2.5-flash). */
  model?: string;
  /** System prompt for this member: site facts + their own order/loyalty summary (built server-side). */
  buildPrompt(userId: string): Promise<string>;
  warn?(msg: string, err?: unknown): void;
  /** Operational log: which model answered. Never message content. */
  info?(msg: string): void;
  now?: () => number;
}

/**
 * Members only. Quota first (cheap, atomic, in the database), then one model call — on the lighter model when the
 * site budget is nearly spent, and once more on the lighter model if the primary is rate-limited. Never throws for
 * expected failures.
 */
export async function answer(
  deps: ChatDeps,
  who: { sessionId: string; ipHash: string | null; userId: string | null },
  messages: Turn[],
): Promise<ChatReply> {
  if (!who.userId) return { ok: false, signInRequired: true, error: SIGN_IN_REQUIRED };
  if (!deps.geminiKey)
    return {
      ok: false,
      error: `The assistant is not available right now. Please call ${SITE_FACTS.phone} or email ${SITE_FACTS.email}.`,
    };
  const now = deps.now?.() ?? Date.now();
  const allowance = () =>
    memberAllowance(deps.quotaDb, deps.quota, who.userId!, now).catch(() => undefined);
  const verdict = await takeChatQuota(deps.quotaDb, deps.quota, who, now);
  if (!verdict.ok) {
    const a = await allowance();
    return {
      ok: false,
      limited: true,
      error: quotaMessage(verdict),
      ...(a ? { allowance: a } : {}),
    };
  }
  const primary = deps.model ?? GEMINI_CHAT_MODEL;
  const used = await siteBudgetUsed(deps.quotaDb, deps.quota, now).catch(() => 0);
  let model = used > FALLBACK_BUDGET_SHARE ? GEMINI_FALLBACK_MODEL : primary;
  try {
    const system = await deps.buildPrompt(who.userId);
    const ask = (m: string) =>
      generateWithRetry(deps.fetch, {
        apiKey: deps.geminiKey!,
        model: m,
        system,
        turns: messages.slice(-12),
        maxOutputTokens: 600,
        temperature: 0.6,
      });
    let out;
    try {
      out = await ask(model);
    } catch (err) {
      if (!(err instanceof GeminiError && err.status === 429) || model === GEMINI_FALLBACK_MODEL)
        throw err;
      model = GEMINI_FALLBACK_MODEL;
      out = await ask(model);
    }
    deps.info?.(`answered by ${model}${model !== primary ? ` (fallback from ${primary})` : ""}`);
    const reply =
      toPlainText(out.text) ||
      "Sorry, I couldn't put an answer together just then. Could you rephrase that?";
    const a = await allowance();
    return { ok: true, reply, ...(a ? { allowance: a } : {}) };
  } catch (err) {
    deps.warn?.("gemini failed", err);
    const busy = err instanceof GeminiError && err.status === 429;
    return {
      ok: false,
      error: busy
        ? "The assistant is a little busy right now. Please try again in a minute."
        : `The assistant is temporarily unavailable. Please call ${SITE_FACTS.phone} or email ${SITE_FACTS.email}.`,
    };
  }
}
