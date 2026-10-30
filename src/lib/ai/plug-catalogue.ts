/**
 * Ask The Plug chat grounding: the in-stock menu the model may talk about, built from the live candidates (active,
 * sold online, available above the safety buffer: the same list the guided match uses) at the moment of the message.
 * Pure, so it is unit-tested. The model never picks products for a member (the guided match does); this list only
 * lets the chat answer questions about what is on the shelf without naming anything that is not.
 */
import type { Candidate } from "@/lib/plug-match";

/** Upper bound on products sent to the model per message (keeps each request well inside the free TPM). */
export const MAX_PROMPT_PRODUCTS = 160;

const clean = (s: string | null | undefined, max: number) =>
  (s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    // Product text is data, not instructions: strip characters that could fake prompt structure.
    .replace(/[<>{}[\]`|#*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const money = (n: number) => (Number.isInteger(n) ? `R${n}` : `R${n.toFixed(2)}`);

export type PlugCatalogue = { prompt: string; size: number };

/** The prompt section for this message. Anything not passed in (out of stock, below the buffer) is simply absent. */
export function buildPlugCatalogue(products: Candidate[]): PlugCatalogue {
  const offered = products
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .slice(0, MAX_PROMPT_PRODUCTS);
  const lines = offered.map((p) => {
    const grade = p.subcategory ? ` / ${clean(p.subcategory, 40)}` : "";
    const strain = p.strainType ? `; ${clean(p.strainType, 30)}` : "";
    const per = p.unit ? ` per ${clean(p.unit, 12)}` : "";
    const sale =
      p.regularPrice && p.regularPrice > p.price
        ? ` (on special, usually ${money(p.regularPrice)})`
        : "";
    return `${clean(p.name, 80)} | ${clean(p.category, 30)}${grade}${strain} | ${money(p.price)}${per}${sale}`;
  });
  return {
    prompt: lines.length
      ? `IN STOCK RIGHT NOW (name | category / grade; strain label | price). Talk about ONLY these products:\n${lines.join("\n")}`
      : "IN STOCK RIGHT NOW: nothing is available to order online at the moment. Do not talk about specific products; suggest checking back later or visiting the shop.",
    size: lines.length,
  };
}
