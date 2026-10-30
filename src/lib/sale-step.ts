// How a product is counted when it is added to a basket (pure; the database enforces the same rule on every sale).
// Weighed products are counted in grams. Outdoor flower is sold in batches of 5 g (R24/g, so R120 a bag), so its
// basket quantity moves 5, 10, 15 ... Everything else moves one at a time.

export const OUTDOOR_BATCH_G = 5;

export type StepFacts = {
  category?: string | null | undefined;
  subcategory?: string | null | undefined;
  name?: string | null | undefined;
  sold_by_weight?: boolean | null | undefined;
  weight_step_g?: number | string | null | undefined;
};

export const isOutdoorFlower = (p: StepFacts): boolean =>
  p.category === "Flower" &&
  ((p.subcategory ?? "").toLowerCase() === "outdoor" || /\(outdoor\)\s*$/i.test(p.name ?? ""));

/** The size of one step (also the smallest purchase): 5 for weighed Outdoor flower, otherwise 1. */
export function saleStep(p: StepFacts): number {
  if (!p.sold_by_weight) return 1;
  const declared = Number(p.weight_step_g);
  const step = Number.isInteger(declared) && declared >= 1 ? declared : 1;
  return isOutdoorFlower(p) ? Math.max(step, OUTDOOR_BATCH_G) : step;
}

/** Rounds a quantity up to a whole number of steps (at least one step). */
export function snapUp(quantity: number, step: number): number {
  if (!Number.isFinite(quantity) || quantity < 1) return step;
  return Math.ceil(quantity / step) * step;
}

/** The nearest whole number of steps at or below the quantity, or 0 when it is less than one step. */
export function snapDown(quantity: number, step: number): number {
  if (!Number.isFinite(quantity) || quantity < step) return 0;
  return Math.floor(quantity / step) * step;
}

/** "5 g" for a weighed product, otherwise the plain number. */
export const quantityLabel = (quantity: number, byWeight: boolean | null | undefined): string =>
  byWeight ? `${quantity} g` : String(quantity);

/** One short line for the shop: "Sold in 5 g batches (R120 a bag)". Null when the product has no batch rule. */
export function batchNote(p: StepFacts & { price_rand: number }): string | null {
  const step = saleStep(p);
  if (step <= 1) return null;
  const bag = Math.round(p.price_rand * step * 100) / 100;
  return `Sold in ${step} g batches (R${bag.toLocaleString("en-ZA", { maximumFractionDigits: 2 })} a bag)`;
}
