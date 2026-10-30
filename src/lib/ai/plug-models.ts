/**
 * Ask The Plug model ladder (Gemini API free tier, verified 30 Oct 2026 against ai.google.dev/gemini-api/docs/pricing
 * and the published free-tier limits; Google shows the live numbers for a project at aistudio.google.com/rate-limit).
 *
 * Google limits the free tier PER PROJECT and PER MODEL (requests per minute, tokens per minute, requests per day;
 * the day resets at midnight Pacific). Each model therefore gets its own guard, set just below Google's figure:
 *
 *   role       default model            free tier (RPM / RPD)   our guard (RPM / RPD)   used for
 *   reasoning  gemini-3.8-flash         5 / 20                  4 / 18                  "Find my match" (deep pick)
 *   chat       gemini-3.5-flash-lite    10 / 500                8 / 450                 the conversation
 *   fallback   gemini-3.1-flash-lite    10 / 500                8 / 450                 when chat is busy or spent
 *
 * The Journal pipeline uses gemini-2.5-flash, a different model with its own Google quota, so it never competes.
 * Every value is overridable in Vercel (e.g. after moving the project to a paid tier):
 *   PLUG_REASONING_MODEL / PLUG_REASONING_RPM / PLUG_REASONING_RPD
 *   PLUG_CHAT_MODEL      / PLUG_CHAT_RPM      / PLUG_CHAT_RPD
 *   PLUG_FALLBACK_MODEL  / PLUG_FALLBACK_RPM  / PLUG_FALLBACK_RPD
 */
import { isModelId, type ThinkingLevel } from "./gemini";

export type ModelRole = "reasoning" | "chat" | "fallback";

export interface PlugModel {
  role: ModelRole;
  id: string;
  rpm: number;
  rpd: number;
  thinkingLevel: ThinkingLevel;
  /** Includes thinking tokens on Gemini 3.x. */
  maxOutputTokens: number;
}

export const DEFAULT_MODELS: Record<ModelRole, Omit<PlugModel, "role">> = {
  reasoning: {
    id: "gemini-3.8-flash",
    rpm: 4,
    rpd: 18,
    thinkingLevel: "medium",
    maxOutputTokens: 4096,
  },
  chat: {
    id: "gemini-3.5-flash-lite",
    rpm: 8,
    rpd: 450,
    thinkingLevel: "low",
    maxOutputTokens: 2048,
  },
  fallback: {
    id: "gemini-3.1-flash-lite",
    rpm: 8,
    rpd: 450,
    thinkingLevel: "low",
    maxOutputTokens: 2048,
  },
};

const posInt = (v: string | undefined, d: number) =>
  v && /^\d{1,6}$/.test(v.trim()) && Number(v) > 0 ? Number(v) : d;

export function plugModels(env: Record<string, string | undefined>): Record<ModelRole, PlugModel> {
  const one = (role: ModelRole): PlugModel => {
    const key = `PLUG_${role.toUpperCase()}`;
    const d = DEFAULT_MODELS[role];
    const id = env[`${key}_MODEL`]?.trim();
    return {
      role,
      ...d,
      id: isModelId(id) ? id : d.id,
      rpm: posInt(env[`${key}_RPM`], d.rpm),
      rpd: posInt(env[`${key}_RPD`], d.rpd),
    };
  };
  return { reasoning: one("reasoning"), chat: one("chat"), fallback: one("fallback") };
}

/**
 * Which models to try, in order, for one message. A deep match prefers the reasoning model; a chat turn starts on
 * the lighter chat model. At most two models are ever tried for one message, so a single message can never use
 * more than two requests of the shared budget.
 */
export function modelLadder(
  models: Record<ModelRole, PlugModel>,
  mode: "chat" | "match",
): PlugModel[] {
  const ladder =
    mode === "match"
      ? [models.reasoning, { ...models.chat, thinkingLevel: "medium" as const }, models.fallback]
      : [models.chat, models.fallback];
  // Same model configured twice (e.g. by env) would double-spend one quota: keep the first only.
  const seen = new Set<string>();
  return ladder.filter((m) => !seen.has(m.id) && seen.add(m.id));
}

export const MAX_MODEL_ATTEMPTS = 2;
