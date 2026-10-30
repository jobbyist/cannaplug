/**
 * Ask The Plug guided match: server side. Every request reads live stock through plug_match_candidates (hard filters
 * and the safety buffer applied in the database, no cache), runs the pure flow in plug-match.ts, and logs what was
 * matched (answers and product ids only, never who). Reserve re-checks the product live; if it has sold out since the
 * card was shown, staff get a recount alert and the card swaps to the next best in-stock match.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { supabaseQuotaDb } from "@/lib/ai/chat.server";
import { commerceSuspended } from "@/lib/commerce-suspension.server";
import {
  cleanAnswers,
  matchProducts,
  nextQuestion,
  type Answers,
  type MatchCard,
  type MatchResult,
  type Question,
} from "@/lib/plug-match";
import { liveCandidates } from "@/lib/plug-stock.server";

/** Quiz taps per hour (no AI is involved, this only protects the database): members, and signed-out visitors per IP. */
export const QUIZ_PER_HOUR = 120;
export const GUEST_QUIZ_PER_HOUR = 60;
/** Who is asking. Anyone may use the quiz (owner's decision, 30 Oct 2026); visitors just get a tighter hourly cap. */
export type Who = { userId: string | null; ipHash: string | null };
export const PAUSED_LABEL = "Available in store today";

async function log(kind: string, outcome: string, answers: Answers, productIds: string[]) {
  const { error } = await supabaseAdmin.rpc("plug_match_log", {
    p_kind: kind,
    p_outcome: outcome,
    p_answers: answers,
    p_product_ids: productIds.slice(0, 10),
  });
  if (error) console.warn("[ask-the-plug] match log failed", error.message);
}

/** What the browser may see of a card: display fields only (no stock count, no score). */
export type PublicCard = Pick<
  MatchCard,
  | "id"
  | "name"
  | "category"
  | "subcategory"
  | "price"
  | "regularPrice"
  | "unit"
  | "imageUrl"
  | "why"
  | "overBudget"
> & { strain: string | null };
const publicCard = (c: MatchCard): PublicCard => ({
  id: c.id,
  name: c.name,
  category: c.category,
  subcategory: c.subcategory,
  strain: c.strainType,
  price: c.price,
  regularPrice: c.regularPrice,
  unit: c.unit,
  imageUrl: c.imageUrl,
  why: c.why,
  overBudget: c.overBudget,
});

export type QuizResponse =
  | { ok: false; error: string; limited?: boolean }
  | { ok: true; kind: "question"; answers: Answers; question: Question }
  | {
      ok: true;
      kind: "result";
      answers: Answers;
      result:
        | {
            status: "matched";
            relaxed: Extract<MatchResult, { status: "matched" }>["relaxed"];
            note: string | null;
            cards: PublicCard[];
          }
        | Extract<MatchResult, { status: "empty" }>;
      checkedAt: string;
      orderingPaused: boolean;
    };

async function gate(who: Who): Promise<{ ok: false; limited: true; error: string } | null> {
  const hour = Math.floor(Date.now() / 3_600_000);
  const [bucket, limit] = who.userId
    ? [`plug:quiz:${who.userId}:${hour}`, QUIZ_PER_HOUR]
    : [`plug:quiz-guest:${who.ipHash ?? "unknown"}:${hour}`, GUEST_QUIZ_PER_HOUR];
  const ok = await supabaseQuotaDb()
    .take(bucket, limit, 2 * 3600)
    .catch(() => false);
  if (!ok)
    return {
      ok: false,
      limited: true,
      error: "That's a lot of taps! Give it a few minutes and try again.",
    };
  return null;
}

/** One quiz step: the next question (with in-stock chip counts) or the match. */
export async function plugQuiz(
  who: Who,
  input: { answers: unknown; exclude?: string[]; another?: boolean },
): Promise<QuizResponse> {
  const refused = await gate(who);
  if (refused) return refused;
  const cands = await liveCandidates();
  const { question, answers } = nextQuestion(cands, cleanAnswers(input.answers));
  if (question) return { ok: true, kind: "question", answers, question };
  const exclude = (input.exclude ?? []).slice(0, 50);
  const result = matchProducts(cands, answers, { exclude, limit: input.another ? 1 : 3 });
  const [paused] = await Promise.all([
    commerceSuspended().catch(() => false),
    log(
      input.another ? "another" : "match",
      result.status === "empty"
        ? "empty"
        : result.relaxed
          ? `relaxed_${result.relaxed}`
          : "matched",
      answers,
      result.status === "matched" ? result.cards.map((c) => c.id) : [],
    ),
  ]);
  return {
    ok: true,
    kind: "result",
    answers,
    result:
      result.status === "matched"
        ? {
            status: "matched",
            relaxed: result.relaxed,
            note: result.note,
            cards: result.cards.map(publicCard),
          }
        : result,
    checkedAt: new Date().toISOString(),
    orderingPaused: paused,
  };
}

export type ReserveResponse =
  | { ok: true; line: { productId: string; name: string; price: number; unit: string | null } }
  | { ok: false; paused: true; error: string }
  | { ok: false; limited?: boolean; error: string }
  | { ok: false; soldOut: true; note: string; replacement: PublicCard | null; checkedAt: string };

/**
 * Reserve for collection: re-check this product live (active, sold online, no recommendation needed, at least one
 * unit free right now). Checkout then places the real hold. A product that has sold out since the card was shown raises
 * a staff recount alert and is swapped for the next best in-stock match.
 */
export async function plugReserve(
  who: Who,
  input: { productId: string; answers: unknown; shown: string[] },
): Promise<ReserveResponse> {
  const refused = await gate(who);
  if (refused) return refused;
  if (await commerceSuspended().catch(() => false))
    return {
      ok: false,
      paused: true,
      error: `Online ordering is paused right now. ${PAUSED_LABEL}.`,
    };
  const answers = cleanAnswers(input.answers);
  const [prod, avail] = await Promise.all([
    supabaseAdmin
      .from("products")
      .select("id,name,price_rand,unit,is_active,sell_online,requires_recommendation")
      .eq("id", input.productId)
      .maybeSingle(),
    supabaseAdmin
      .from("inventory_availability")
      .select("available")
      .eq("product_id", input.productId)
      .maybeSingle(),
  ]);
  if (prod.error) throw new Error(prod.error.message);
  // A failed availability read must never look like "sold out": that would log a false failure and alert staff.
  if (avail.error) throw new Error(avail.error.message);
  const p = prod.data as {
    id: string;
    name: string;
    price_rand: number;
    unit: string | null;
    is_active: boolean;
    sell_online: boolean;
    requires_recommendation: boolean;
  } | null;
  const available = Number((avail.data as { available?: number } | null)?.available ?? 0);
  const sellable = Boolean(p && p.is_active && p.sell_online && !p.requires_recommendation);
  if (p && sellable && available >= 1) {
    await log("reserve_ok", "ok", answers, [p.id]);
    return {
      ok: true,
      line: { productId: p.id, name: p.name, price: Number(p.price_rand), unit: p.unit },
    };
  }
  // Sold out (or taken off sale) between the card and the tap: alert staff only for stock, then swap.
  if (p && sellable) await log("reserve_stock_fail", "sold_out", answers, [p.id]);
  const exclude = [...new Set([...(input.shown ?? []), input.productId])].slice(0, 50);
  const next = matchProducts(await liveCandidates(), answers, { exclude, limit: 1 });
  return {
    ok: false,
    soldOut: true,
    note:
      next.status === "matched"
        ? "That one just sold out. Here's the next best match that's in stock right now:"
        : "That one just sold out, and nothing else fits right now. Pop into the shop and the team will help.",
    replacement: next.status === "matched" ? publicCard(next.cards[0]!) : null,
    checkedAt: new Date().toISOString(),
  };
}
