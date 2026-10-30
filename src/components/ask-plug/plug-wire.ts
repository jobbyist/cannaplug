import type { plugQuizFn } from "@/lib/plug-match.functions";

type Quiz = Extract<Awaited<ReturnType<typeof plugQuizFn>>, { ok: true }>;
type Matched = Extract<Extract<Quiz, { kind: "result" }>["result"], { status: "matched" }>;
export type PlugCardData = Matched["cards"][number];
export type QuizChip = { value: string; label: string; count?: number };

export type PlugMessage = {
  role: "user" | "assistant";
  content: string;
  /** Free-text chat suggestions. "Find my match" and "Start over" are handled as quiz actions. */
  quickReplies?: string[];
  /** A quiz question: the step it asks and the tap-to-answer chips (only formats with stock behind them). */
  question?: { step: string; chips: QuizChip[] };
  /** The answers so far, as cleaned by the server. The next tap adds to these. */
  answers?: Record<string, string>;
  /** A match: up to three in-stock cards, when stock was checked, and whether ordering is paused. */
  cards?: PlugCardData[];
  checkedAt?: string;
  paused?: boolean;
  /** Show a Go to checkout link (after Reserve for collection). */
  checkout?: boolean;
};

export const MAX_INPUT = 500;
export const FIND_MATCH = "Find my match";
export const START_OVER = "Start over";
/** A shown match is re-run after this long (spec: the result expires after 10 minutes). */
export const RESULT_TTL_MS = 10 * 60_000;

export const STARTERS = [FIND_MATCH, "What's on special?", "Indica vs sativa, what's the deal?"];

/** Turns one quiz response from the server into the next message in the thread. */
export function messageFromQuiz(r: Quiz): PlugMessage {
  if (r.kind === "question")
    return {
      role: "assistant",
      content: r.question.say,
      question: { step: r.question.step, chips: r.question.chips },
      answers: r.answers,
    };
  if (r.result.status === "matched")
    return {
      role: "assistant",
      content: r.result.note ?? "Here's what fits, and it's all in stock right now:",
      cards: r.result.cards,
      checkedAt: r.checkedAt,
      paused: r.orderingPaused,
      answers: r.answers,
      quickReplies: [START_OVER],
    };
  const formats = r.result.otherFormats;
  const base: PlugMessage = {
    role: "assistant",
    content: r.result.note,
    checkedAt: r.checkedAt,
    quickReplies: [START_OVER],
  };
  if (!formats.length) return base;
  // Keep the experience answer, offer the formats that do have stock. Never a silent swap of format.
  return {
    ...base,
    content: `${r.result.note} These are available instead:`,
    question: { step: "format", chips: formats.map((f) => ({ value: f.value, label: f.label })) },
    answers: r.answers.experience ? { experience: r.answers.experience } : {},
  };
}

/** What is sent to the server for free-text chat: text only (never product data), the greeting left out. */
export function toWire(messages: PlugMessage[]) {
  return messages
    .slice(1)
    .filter((m) => m.content.trim() && !m.cards?.length && !m.question)
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, m.role === "user" ? MAX_INPUT : 900),
    }))
    .slice(-20);
}
