/**
 * Direct Gemini API client (Generative Language API, `generateContent`). Pure and fetch-injected for tests.
 * Model: gemini-2.5-flash. Thinking is disabled for chat (budget 0): it is faster, cheaper and the replies are short.
 * Docs: https://ai.google.dev/gemini-api/docs/text-generation
 */
export const GEMINI_CHAT_MODEL = "gemini-2.5-flash";
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
  /** Ask for JSON back (used by the Journal pipeline). */
  json?: boolean;
  thinkingBudget?: number;
  timeoutMs?: number;
}

export async function generate(
  fetchFn: FetchLike,
  o: GenerateOptions,
): Promise<{ text: string; usage: { input: number; output: number } }> {
  const model = o.model ?? GEMINI_CHAT_MODEL;
  const body = {
    systemInstruction: { parts: [{ text: o.system }] },
    contents: o.turns.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    generationConfig: {
      temperature: o.temperature ?? 0.6,
      maxOutputTokens: o.maxOutputTokens ?? 700,
      ...(o.json ? { responseMimeType: "application/json" } : {}),
      thinkingConfig: { thinkingBudget: o.thinkingBudget ?? 0 },
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
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
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
