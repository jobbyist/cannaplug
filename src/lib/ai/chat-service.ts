/**
 * Ask The Plug free-text chat: one member question in, one friendly answer out. Pure orchestration with injected
 * dependencies, so every guardrail is unit-tested without a database or Google.
 *
 * Products are chosen by the guided match (src/lib/plug-match.ts), never by the model. The chat answers questions
 * (what grades mean, what's on special, store facts) and is fed only what is in stock right now.
 *
 * Order (cheapest refusal first, nothing reaches Gemini unless every check passes):
 *   Gemini configured → quota (members: member/IP/session; signed-out visitors: a much smaller per-visitor, per-session
 *   and shared daily allowance) → today's
 *   in-stock menu (live, safety buffer applied) → model ladder (per-model RPM/RPD slot before each call, at most two
 *   calls) → parse → health-claim guard → stock check: a reply naming a product that is not available is regenerated
 *   once, then replaced with a safe answer pointing to the guided match.
 */
import { SITE_FACTS, buildPlugPrompt } from "./chat-prompt";
import { generateWithRetry, GeminiError, type FetchLike, type Turn } from "./gemini";
import { buildPlugCatalogue } from "./plug-catalogue";
import type { Candidate } from "../plug-match";
import {
  complianceGuard,
  mentionsUnavailable,
  parsePlugOutput,
  PLUG_RESPONSE_SCHEMA,
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

export type PlugReply =
  | { ok: true; reply: string; quickReplies: string[]; startMatch: boolean; allowance?: Allowance }
  | {
      ok: false;
      error: string;
      limited?: boolean;
      allowance?: Allowance;
    };
/** Kept for older imports. */
export type ChatReply = PlugReply;

/** Shown instead of a reply that keeps naming a product that is not available today. */
export const STOCK_SAFE_REPLY =
  "I can only talk about what's on the shelf today, and I couldn't confirm that one is available. Tap Find my match and I'll check live stock for you.";

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
  /**
   * What is offered right now (live, hard filters and safety buffer applied in the database) and the names of active
   * products that are NOT available, for the reply check.
   */
  loadCatalogue(): Promise<{ products: Candidate[]; unavailableNames: string[] }>;
  /** Reward tiers and this member's own allow-listed summary. */
  loadContext(userId: string | null): Promise<{ tiers: string; member: string }>;
  /** Monitoring: a reply replaced for naming an unavailable product (no content is logged). */
  logReplaced?(): Promise<void>;
  warn?(msg: string, err?: unknown): void;
  /** Operational log: which model answered and whether a guard stepped in. Never message content. */
  info?(msg: string): void;
  now?: () => number;
}

const unavailable = `The Plug is unavailable right now. Please call ${SITE_FACTS.phone} or email ${SITE_FACTS.email}.`;

export async function answer(
  deps: ChatDeps,
  who: { sessionId: string; ipHash: string | null; userId: string | null },
  messages: Turn[],
): Promise<PlugReply> {
  // Open to everyone (owner's decision, 30 Oct 2026): signed-out visitors get a much smaller allowance (quota.ts).
  const userId = who.userId;
  if (!deps.geminiKey) return { ok: false, error: unavailable };
  const turns = trimHistory(messages);
  if (!turns.length || turns[turns.length - 1]!.role !== "user")
    return { ok: false, error: "Send me a message and I'll get going." };

  const now = deps.now?.() ?? Date.now();
  const allowance = () =>
    userId
      ? memberAllowance(deps.quotaDb, deps.quota, userId, now).catch(() => undefined)
      : Promise.resolve(undefined);
  const verdict = await takeMemberQuota(deps.quotaDb, deps.quota, who, now);
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
  let hidden: string[];
  let offered: string[];
  try {
    const [cat, context] = await Promise.all([
      deps.loadCatalogue(),
      deps.loadContext(userId).catch(() => ({ tiers: "", member: "" })),
    ]);
    system = buildPlugPrompt({ catalogue: buildPlugCatalogue(cat.products).prompt, ...context });
    hidden = cat.unavailableNames;
    offered = cat.products.map((p) => p.name);
  } catch (err) {
    deps.warn?.("catalogue unavailable", err);
    return { ok: false, error: unavailable };
  }

  let attempts = 0;
  let refusal: "busy" | "daily" | null = null;
  const call = async (sys: string, model: PlugModel) =>
    generateWithRetry(deps.fetch, {
      apiKey: deps.geminiKey!,
      model: model.id,
      system: sys,
      turns,
      json: true,
      schema: PLUG_RESPONSE_SCHEMA,
      thinkingLevel: model.thinkingLevel,
      maxOutputTokens: model.maxOutputTokens,
    });
  let out: { text: string } | null = null;
  let answeredBy: PlugModel | null = null;
  for (const model of modelLadder(deps.models)) {
    if (attempts >= MAX_MODEL_ATTEMPTS) break;
    const slot = await takeModelSlot(deps.quotaDb, model, now).catch(() => "busy" as const);
    if (slot !== "ok") {
      if (refusal !== "busy") refusal = slot;
      continue;
    }
    attempts++;
    try {
      out = await call(system, model);
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

  let parsed = parsePlugOutput(out.text);
  let notes: string[] = [];
  // Stock check (spec layer 6): regenerate once, within the two-call cap, then replace.
  let named = mentionsUnavailable(parsed.reply, hidden, offered);
  if (named.length && attempts < MAX_MODEL_ATTEMPTS) {
    const slot = await takeModelSlot(deps.quotaDb, answeredBy, now).catch(() => "busy" as const);
    if (slot === "ok") {
      attempts++;
      try {
        const retry = await call(
          `${system}\n\nCORRECTION: your previous draft mentioned products that are NOT available today (${named.join(", ")}). Do not mention them; answer again using only the in-stock list.`,
          answeredBy,
        );
        parsed = parsePlugOutput(retry.text);
        named = mentionsUnavailable(parsed.reply, hidden, offered);
        notes.push("regenerated");
      } catch (err) {
        deps.warn?.("stock-check regeneration failed", err);
      }
    }
  }
  let reply = parsed.reply;
  let quick = parsed.quickReplies;
  if (named.length) {
    reply = STOCK_SAFE_REPLY;
    quick = [];
    notes = [...notes, "stock guard replaced the reply"];
    await deps.logReplaced?.().catch(() => undefined);
  }
  const guarded = complianceGuard({ reply });
  if (guarded.blocked) {
    quick = [];
    notes.push("health guard replaced the reply");
  }
  deps.info?.(
    `answered by ${answeredBy.id} (${answeredBy.role})${notes.length ? ` · ${notes.join(" · ")}` : ""}`,
  );
  const a = await allowance();
  return {
    ok: true,
    reply:
      guarded.reply || "Sorry, I lost my train of thought there. Could you say that another way?",
    quickReplies: quick,
    startMatch: parsed.startMatch && !guarded.blocked,
    ...(a ? { allowance: a } : {}),
  };
}
