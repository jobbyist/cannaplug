/**
 * Ask The Plug: one member message in, one budtender reply out. Pure orchestration with injected dependencies, so
 * the guardrails are unit-tested without a database or Google.
 *
 * Order (cheapest refusal first, nothing reaches Gemini unless every check passes):
 *   signed in → Gemini configured → verified member (server-side, not just hidden in the UI) → member/IP/session
 *   quota → today's in-stock menu → model ladder (per-model RPM/RPD slot before each call, at most two calls) →
 *   parse → keep only menu picks → health-claim guard → reply.
 */
import { SITE_FACTS, buildPlugPrompt } from "./chat-prompt";
import { generateWithRetry, GeminiError, type FetchLike, type Turn } from "./gemini";
import { buildPlugCatalogue, type StoreProduct } from "./plug-catalogue";
import {
  complianceGuard,
  parsePlugOutput,
  PLUG_RESPONSE_SCHEMA,
  resolvePicks,
  type PlugPick,
} from "./plug-guard";
import { MAX_MODEL_ATTEMPTS, modelLadder, type ModelRole, type PlugModel } from "./plug-models";
import {
  memberAllowance,
  quotaMessage,
  takeMemberQuota,
  takeModelSlot,
  type Allowance,
  type QuotaConfig,
  type QuotaDb,
} from "./quota";

export { toPlainText } from "./text";
export type { Allowance };
export type ChatMode = "chat" | "match";

export type PlugReply =
  | {
      ok: true;
      reply: string;
      quickReplies: string[];
      picks: PlugPick[];
      readyToMatch: boolean;
      allowance?: Allowance;
    }
  | {
      ok: false;
      error: string;
      limited?: boolean;
      signInRequired?: boolean;
      notEligible?: boolean;
      allowance?: Allowance;
    };
/** Kept for older imports. */
export type ChatReply = PlugReply;

export const SIGN_IN_REQUIRED = "sign_in_required";
export const NOT_ELIGIBLE_MESSAGE =
  "Ask The Plug is for verified members. Verify your ID in your account (it only takes a minute) and I'll be right here.";

/** Per-message input caps (the server function's schema enforces them too). */
export const MAX_USER_CHARS = 500;
const MAX_ASSISTANT_CHARS = 900;
const MAX_TURNS = 12;
const MAX_HISTORY_CHARS = 7000;

/** The conversation as sent to the model: recent turns only, clipped, starting with the member, within a budget. */
export function trimHistory(messages: Turn[]): Turn[] {
  const clipped = messages
    .slice(-MAX_TURNS)
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, m.role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS),
    }))
    .filter((m) => m.content);
  let total = clipped.reduce((s, m) => s + m.content.length, 0);
  while (clipped.length > 1 && (total > MAX_HISTORY_CHARS || clipped[0]!.role !== "user")) {
    total -= clipped.shift()!.content.length;
  }
  return clipped;
}

export interface ChatDeps {
  quotaDb: QuotaDb;
  quota: QuotaConfig;
  models: Record<ModelRole, PlugModel>;
  fetch: FetchLike;
  geminiKey: string | null;
  /** Verified member (ID approved and not expired) or staff. Checked on the server for every message. */
  isEligible(userId: string): Promise<boolean>;
  /** The shop's live listing (active, sold online, with in_stock), read at the time of the message. */
  loadCatalogue(): Promise<StoreProduct[]>;
  /** Reward tiers and this member's own allow-listed summary. */
  loadContext(userId: string): Promise<{ tiers: string; member: string }>;
  warn?(msg: string, err?: unknown): void;
  /** Operational log: which model answered and whether the guard stepped in. Never message content. */
  info?(msg: string): void;
  now?: () => number;
}

const unavailable = `The Plug is unavailable right now. Please call ${SITE_FACTS.phone} or email ${SITE_FACTS.email}.`;

export async function answer(
  deps: ChatDeps,
  who: { sessionId: string; ipHash: string | null; userId: string | null },
  messages: Turn[],
  mode: ChatMode = "chat",
): Promise<PlugReply> {
  if (!who.userId) return { ok: false, signInRequired: true, error: SIGN_IN_REQUIRED };
  const userId = who.userId;
  if (!deps.geminiKey) return { ok: false, error: unavailable };
  const turns = trimHistory(messages);
  if (!turns.length || turns[turns.length - 1]!.role !== "user")
    return { ok: false, error: "Send me a message and I'll get going." };
  if (!(await deps.isEligible(userId).catch(() => false)))
    return { ok: false, notEligible: true, error: NOT_ELIGIBLE_MESSAGE };

  const now = deps.now?.() ?? Date.now();
  const allowance = () =>
    memberAllowance(deps.quotaDb, deps.quota, userId, now).catch(() => undefined);
  const verdict = await takeMemberQuota(deps.quotaDb, deps.quota, { ...who, userId }, mode, now);
  if (!verdict.ok) {
    const a = await allowance();
    return {
      ok: false,
      limited: true,
      error: quotaMessage(verdict),
      ...(a ? { allowance: a } : {}),
    };
  }

  let system: string;
  let catalogue: ReturnType<typeof buildPlugCatalogue>;
  try {
    const [products, context] = await Promise.all([
      deps.loadCatalogue(),
      deps.loadContext(userId).catch(() => ({ tiers: "", member: "" })),
    ]);
    catalogue = buildPlugCatalogue(products);
    system = buildPlugPrompt({ catalogue: catalogue.prompt, ...context, mode });
  } catch (err) {
    deps.warn?.("catalogue unavailable", err);
    return { ok: false, error: unavailable };
  }

  let attempts = 0;
  let refusal: "busy" | "daily" | null = null;
  let out: { text: string } | null = null;
  let answeredBy: PlugModel | null = null;
  for (const model of modelLadder(deps.models, mode)) {
    if (attempts >= MAX_MODEL_ATTEMPTS) break;
    const slot = await takeModelSlot(deps.quotaDb, model, now).catch(() => "busy" as const);
    if (slot !== "ok") {
      if (refusal !== "busy") refusal = slot;
      continue;
    }
    attempts++;
    try {
      out = await generateWithRetry(deps.fetch, {
        apiKey: deps.geminiKey,
        model: model.id,
        system,
        turns,
        json: true,
        schema: PLUG_RESPONSE_SCHEMA,
        thinkingLevel: model.thinkingLevel,
        maxOutputTokens: model.maxOutputTokens,
      });
      answeredBy = model;
      break;
    } catch (err) {
      if (err instanceof GeminiError && err.status === 429) {
        refusal = "busy";
        continue; // Google says this model is busy or spent: try the next one
      }
      deps.warn?.(`gemini failed on ${model.id}`, err);
      break;
    }
  }

  if (!out || !answeredBy) {
    const a = await allowance();
    if (refusal)
      return {
        ok: false,
        limited: true,
        error: quotaMessage({ ok: false, reason: refusal, retryAfterMinutes: 1 }),
        ...(a ? { allowance: a } : {}),
      };
    return { ok: false, error: unavailable, ...(a ? { allowance: a } : {}) };
  }

  const parsed = parsePlugOutput(out.text);
  const guarded = complianceGuard({
    reply: parsed.reply,
    picks: resolvePicks(parsed.picks, catalogue),
  });
  const reply =
    guarded.reply ||
    (guarded.picks.length
      ? "Here's what I'd go for:"
      : "Sorry, I lost my train of thought there. Could you say that another way?");
  deps.info?.(
    `answered by ${answeredBy.id} (${answeredBy.role}, ${mode})${guarded.blocked ? " · health guard replaced the reply" : ""}`,
  );
  const a = await allowance();
  return {
    ok: true,
    reply,
    quickReplies: guarded.blocked ? [] : parsed.quickReplies,
    picks: guarded.picks,
    readyToMatch: parsed.readyToMatch,
    ...(a ? { allowance: a } : {}),
  };
}
