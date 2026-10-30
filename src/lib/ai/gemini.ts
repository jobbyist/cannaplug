/**
 * Direct Gemini API client (Generative Language API, `generateContent`). Pure and fetch-injected for tests.
 * Ask The Plug uses the Gemini 3.x free-tier models (see src/lib/ai/plug-models.ts), which take a thinking LEVEL;
 * the Journal pipeline still uses gemini-2.5-flash with a thinking BUDGET. A request carries one or the other, never
 * both (Google answers 400 to a request with both).
 * Docs: https://ai.google.dev/gemini-api/docs/text-generation, https://ai.google.dev/gemini-api/docs/thinking
 */
const MODEL_RE = /^gemini-[a-z0-9.-]{3,40}$/;
/** True when a string looks like a Gemini model id (env values are checked before they reach a URL). */
export const isModelId = (m: string | undefined | null): m is string =>
  Boolean(m && MODEL_RE.test(m));
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";
const BASE = "https://generativelanguage.googleapis.com/v1beta";

export type Turn = { role: "user" | "assistant"; content: string };
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when retrying later may work (rate limit / overload / network). */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export interface GenerateOptions {
  apiKey: string;
  model?: string;
  system: string;
  turns: Turn[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask for JSON back (used by the Journal pipeline and Ask The Plug). */
  json?: boolean;
  /** Optional response schema (OpenAPI subset) for structured JSON output; only sent with `json`. */
  schema?: Record<string, unknown>;
  /** Gemini 2.5 models: token budget for thinking (default 0 = off). Ignored when `thinkingLevel` is set. */
  thinkingBudget?: number;
  /** Gemini 3.x models: minimal | low | medium | high. */
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
}

export async function generate(
  fetchFn: FetchLike,
  o: GenerateOptions,
): Promise<{ text: string; usage: { input: number; output: number } }> {
  if (!isModelId(o.model)) throw new GeminiError("invalid model", 400, false);
  const model = o.model;
  const body = {
    systemInstruction: { parts: [{ text: o.system }] },
    contents: o.turns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    generationConfig: {
      // Google recommends leaving Gemini 3 at its default temperature (1.0); 2.5 callers pass their own.
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      maxOutputTokens: o.maxOutputTokens ?? 700,
      ...(o.json ? { responseMimeType: "application/json" } : {}),
      ...(o.json && o.schema ? { responseSchema: o.schema } : {}),
      thinkingConfig: o.thinkingLevel
        ? { thinkingLevel: o.thinkingLevel }
        : { thinkingBudget: o.thinkingBudget ?? 0 },
    },
    // Chat and articles are not the place for blocked-content surprises, but keep Google's defaults for harassment/etc.
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 25_000);
  let res;
  try {
    res = await fetchFn(`${BASE}/models/${model}:generateContent`, {
      method: "POST",
      // The key travels in a header, never in the URL (URLs end up in logs).
      headers: { "Content-Type": "application/json", "x-goog-api-key": o.apiKey },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new GeminiError(err instanceof Error ? err.message : "network error", 0, true);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  if (!res.ok) {
    const transient = res.status === 429 || res.status >= 500 || res.status === 408;
    throw new GeminiError(`Gemini ${res.status}`, res.status, transient);
  }
  let json: {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
      finishReason?: string;
    }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  try {
    json = JSON.parse(raw);
  } catch {
    throw new GeminiError("unreadable response", res.status, true);
  }
  if (json.promptFeedback?.blockReason) throw new GeminiError("blocked", 400, false);
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought) // thought summaries are never shown to anyone
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  return {
    text,
    usage: {
      input: json.usageMetadata?.promptTokenCount ?? 0,
      output: json.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

/** One retry for transient failures, with a short pause. Quota is taken by the caller BEFORE the first attempt only. */
export async function generateWithRetry(
  fetchFn: FetchLike,
  o: GenerateOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  try {
    return await generate(fetchFn, o);
  } catch (err) {
    if (err instanceof GeminiError && err.transient && err.status !== 429) {
      await sleep(600);
      return generate(fetchFn, o);
    }
    throw err;
  }
}
