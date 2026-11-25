// How a product is counted when it is added to a basket (pure; the database enforces the same rule on every sale).
// Weighed products are counted in grams and sold in their own step: 1 g by default, 0.5 g when the product is set up
// for half grams, and 5 g for Outdoor flower (R24/g, so R120 a bag). Everything else moves one unit at a time.
// Quantities are exact to one decimal place, so all arithmetic here goes through whole tenths (see qty.ts).

import { fromTenths, toTenths } from "@/lib/qty";

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

/** The size of one step (also the smallest purchase): 5 for weighed Outdoor flower, 0.5 or 1 for other weighed products, otherwise 1. */
export function saleStep(p: StepFacts): number {
  if (!p.sold_by_weight) return 1;
  const declared = Number(p.weight_step_g);
  const step = declared === 0.5 || declared === 1 || declared === 5 ? declared : 1;
  return isOutdoorFlower(p) ? Math.max(step, OUTDOOR_BATCH_G) : step;
}

/** Rounds a quantity up to a whole number of steps (at least one step). */
export function snapUp(quantity: number, step: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return step;
  const s = toTenths(step);
  return fromTenths(Math.ceil(toTenths(quantity) / s) * s);
}

/** The nearest whole number of steps at or below the quantity, or 0 when it is less than one step. */
export function snapDown(quantity: number, step: number): number {
  if (!Number.isFinite(quantity) || quantity < step) return 0;
  const s = toTenths(step);
  return fromTenths(Math.floor(toTenths(quantity) / s) * s);
}

/** "5 g" for a weighed product, otherwise the plain number. */
export const quantityLabel = (quantity: number, byWeight: boolean | null | undefined): string =>
  byWeight ? `${fromTenths(toTenths(quantity))} g` : String(quantity);

/** One short line for the shop: "Sold in 5 g batches (R120 a bag)". Null when the product has no batch rule. */
export function batchNote(p: StepFacts & { price_rand: number }): string | null {
  const step = saleStep(p);
  if (step <= 1) return null;
  const bag = Math.round(p.price_rand * step * 100) / 100;
  return `Sold in ${step} g batches (R${bag.toLocaleString("en-ZA", { maximumFractionDigits: 2 })} a bag)`;
}
