import { SITE_FACTS } from "./chat-prompt";
import {
  generateWithRetry,
  GeminiError,
  GEMINI_CHAT_MODEL,
  type FetchLike,
  type Turn,
} from "./gemini";
import { quotaMessage, takeChatQuota, type QuotaConfig, type QuotaDb } from "./quota";

export type ChatReply =
  { ok: true; reply: string } | { ok: false; error: string; limited?: boolean };

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
  buildPrompt(): Promise<string>;
  warn?(msg: string, err?: unknown): void;
  now?: () => number;
}

/** Quota first (cheap, atomic, in the database), then exactly one model call. Never throws for expected failures. */
export async function answer(
  deps: ChatDeps,
  who: { sessionId: string; ipHash: string | null },
  messages: Turn[],
): Promise<ChatReply> {
  if (!deps.geminiKey)
    return {
      ok: false,
      error: `The assistant is not available right now. Please call ${SITE_FACTS.phone} or email ${SITE_FACTS.email}.`,
    };
  const verdict = await takeChatQuota(deps.quotaDb, deps.quota, who, deps.now?.());
  if (!verdict.ok) return { ok: false, limited: true, error: quotaMessage(verdict) };
  try {
    const out = await generateWithRetry(deps.fetch, {
      apiKey: deps.geminiKey,
      model: GEMINI_CHAT_MODEL,
      system: await deps.buildPrompt(),
      turns: messages.slice(-12),
      maxOutputTokens: 600,
      temperature: 0.6,
    });
    const reply =
      toPlainText(out.text) ||
      "Sorry, I couldn't put an answer together just then. Could you rephrase that?";
    return { ok: true, reply };
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
