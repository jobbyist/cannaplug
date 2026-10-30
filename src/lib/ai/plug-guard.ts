/**
 * What leaves the server after the model answers. Pure, so every rule is unit-tested (with mutation checks).
 *  - parsePlugOutput: reads the model's JSON (or falls back to plain text), caps every field.
 *  - resolvePicks: keeps only picks whose ref is on THIS message's in-stock menu; product fields come from the database.
 *  - complianceGuard: refuses to show a reply that makes a health claim or gives a dose, whatever the prompt said.
 */
import type { PlugCatalogue, PlugProduct } from "./plug-catalogue";
import { toPlainText } from "./text";

/** Structured-output schema sent to Gemini (OpenAPI subset accepted by generationConfig.responseSchema). */
export const PLUG_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    quick_replies: { type: "ARRAY", items: { type: "STRING" } },
    picks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { ref: { type: "STRING" }, why: { type: "STRING" } },
        required: ["ref", "why"],
      },
    },
    ready_to_match: { type: "BOOLEAN" },
  },
  required: ["reply"],
} as const;

export type RawPick = { ref: string; why: string };
export type PlugOutput = {
  reply: string;
  quickReplies: string[];
  picks: RawPick[];
  readyToMatch: boolean;
};

const str = (v: unknown, max: number) =>
  typeof v === "string" ? toPlainText(v).replace(/\s+/g, " ").trim().slice(0, max) : "";

export function parsePlugOutput(text: string): PlugOutput {
  let raw: Record<string, unknown> | null = null;
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      raw = parsed as Record<string, unknown>;
  } catch {
    /* not JSON: treat as a plain reply below */
  }
  if (!raw)
    return {
      reply: toPlainText(text).slice(0, 900),
      quickReplies: [],
      picks: [],
      readyToMatch: false,
    };
  const reply = typeof raw["reply"] === "string" ? toPlainText(raw["reply"]).slice(0, 900) : "";
  const quick = Array.isArray(raw["quick_replies"]) ? raw["quick_replies"] : [];
  const picks = Array.isArray(raw["picks"]) ? raw["picks"] : [];
  const seen = new Set<string>();
  return {
    reply,
    quickReplies: quick
      .map((q) => str(q, 40))
      .filter((q) => q && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()))
      .slice(0, 4),
    picks: picks
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
      .map((p) => ({ ref: str(p["ref"], 8).toUpperCase(), why: str(p["why"], 200) }))
      .filter((p) => /^P\d{1,4}$/.test(p.ref))
      .slice(0, 3),
    readyToMatch: raw["ready_to_match"] === true,
  };
}

export type PlugPick = PlugProduct & { why: string };

/** Picks on this message's menu only (a ref the model made up, or repeated, is dropped). */
export function resolvePicks(
  picks: RawPick[],
  catalogue: Pick<PlugCatalogue, "byRef">,
): PlugPick[] {
  const out: PlugPick[] = [];
  const used = new Set<string>();
  for (const p of picks) {
    const product = catalogue.byRef.get(p.ref);
    if (!product || used.has(product.id)) continue;
    used.add(product.id);
    out.push({ ...product, why: p.why });
  }
  return out;
}

/**
 * Health claims and dosing that must never reach the screen. Deliberately specific: a sentence that DECLINES health
 * advice ("I can't advise on anxiety, please see a doctor") is allowed, so the patterns look for claim verbs aimed at
 * a condition, and for dose instructions.
 */
const CONDITION =
  "(?:pain|aches?|anxiety|stress|depression|insomnia|sleep(?:lessness)?|nausea|appetite|inflammation|arthritis|migraines?|headaches?|seizures?|epilepsy|cancer|ptsd|adhd|cramps?|spasms?|glaucoma|hiv|crohn'?s|ms\\b|multiple sclerosis|panic|trauma)";
const CLAIM_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:treats?|treating|cures?|curing|heals?|healing|relieves?|relieving|relief (?:for|from)|reduces?|eases?|easing|soothes?|fights?|prevents?|remedy for|good for|great for|best for|helps? (?:with|you with|to (?:treat|reduce|ease|relieve|manage)))\\b[^.!?]{0,40}\\b${CONDITION}`,
    "i",
  ),
  new RegExp(`\\b${CONDITION}\\b[^.!?]{0,30}\\b(?:relief|treatment|remedy|cure)\\b`, "i"),
  /\b(?:take|try|start with|use|have|eat|smoke|dose of)\s+(?:about\s+|around\s+|just\s+)?\d+(?:[.,]\d+)?\s*(?:mg|milligrams?|ml|g|grams?|puffs?|drops?|gummies|pieces?|hits?)\b/i,
  /\b(?:medicinal|medical|therapeutic|clinical) (?:benefits?|properties|effects?)\b/i,
];

export const SAFE_HEALTH_REPLY =
  "I can't give health or dosing advice, so please chat to a doctor or pharmacist about that. I'm happy to help you compare products by format, grade, flavour or budget though!";

export function makesHealthClaim(text: string): boolean {
  // Only sentences that are not themselves declining advice.
  return text
    .split(/(?<=[.!?])\s+/)
    .some(
      (sentence) =>
        !/\b(?:can'?t|cannot|can not|won'?t|not able to|unable to|don'?t) (?:give|offer|provide|advise|help with health)/i.test(
          sentence,
        ) && CLAIM_PATTERNS.some((re) => re.test(sentence)),
    );
}

/** Replaces a reply (and its picks' reasons) that breaks the health rules. Returns whether it intervened. */
export function complianceGuard(out: { reply: string; picks: PlugPick[] }): {
  reply: string;
  picks: PlugPick[];
  blocked: boolean;
} {
  if (makesHealthClaim(out.reply)) return { reply: SAFE_HEALTH_REPLY, picks: [], blocked: true };
  const picks = out.picks.map((p) =>
    makesHealthClaim(p.why) ? { ...p, why: "Matches what you told me you're after." } : p,
  );
  return { reply: out.reply, picks, blocked: false };
}
