/**
 * Ask The Plug grounding: the menu the model may recommend from, built from the shop's own listing (active, sold
 * online, in stock — the same rule as /shop) at the moment of the message. Pure, so it is unit-tested.
 *
 * Each product gets a short reference (P1, P2, …) that is only meaningful for this one prompt. The model answers with
 * references; the server maps them back to products and takes every displayed field (name, price, unit, image,
 * strain) from the database row, never from the model's text. A reference that is not on this menu is dropped.
 */
import { strainOf } from "@/lib/shop-filter";

export type StoreProduct = {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  strain_type: string | null;
  price_rand: number;
  regular_price_rand: number | null;
  unit: string | null;
  badge: string | null;
  description: string | null;
  in_stock: boolean;
  image_url: string | null;
  sold_by_weight?: boolean | null;
};

export type PlugProduct = {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  strain: string | null;
  price: number;
  regularPrice: number | null;
  unit: string | null;
  imageUrl: string | null;
  shopHref: string;
};

export type PlugCatalogue = { prompt: string; byRef: Map<string, PlugProduct>; size: number };

/** Upper bound on products sent to the model per message (keeps each request well inside the free TPM). */
export const MAX_PROMPT_PRODUCTS = 160;
const DESC_MAX = 160;

const clean = (s: string | null | undefined, max: number) =>
  (s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    // Product text is data, not instructions: strip characters that could fake prompt structure.
    .replace(/[<>{}[\]`|#*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const money = (n: number) => (Number.isInteger(n) ? `R${n}` : `R${n.toFixed(2)}`);

export function toPlugProduct(p: StoreProduct): PlugProduct {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    subcategory: p.subcategory,
    strain: strainOf(p.strain_type),
    price: Number(p.price_rand),
    regularPrice:
      p.regular_price_rand != null && Number(p.regular_price_rand) > Number(p.price_rand)
        ? Number(p.regular_price_rand)
        : null,
    unit: p.unit,
    imageUrl: p.image_url,
    shopHref: `/shop?q=${encodeURIComponent(p.name.slice(0, 80))}`,
  };
}

/** The prompt section and the reference map for this message. Out-of-stock products are never offered. */
export function buildPlugCatalogue(products: StoreProduct[]): PlugCatalogue {
  const offered = products
    .filter((p) => p.in_stock && Number.isFinite(Number(p.price_rand)) && Number(p.price_rand) > 0)
    .slice(0, MAX_PROMPT_PRODUCTS);
  const byRef = new Map<string, PlugProduct>();
  const lines = offered.map((p, i) => {
    const ref = `P${i + 1}`;
    const prod = toPlugProduct(p);
    byRef.set(ref, prod);
    const grade = p.subcategory ? ` / ${clean(p.subcategory, 40)}` : "";
    const strain = prod.strain ? `; ${prod.strain}` : "";
    const per = p.unit ? ` per ${clean(p.unit, 12)}` : "";
    const sale = prod.regularPrice ? ` (on special, usually ${money(prod.regularPrice)})` : "";
    const badge = p.badge ? `; ${clean(p.badge, 24)}` : "";
    const desc = p.description ? ` — ${clean(p.description, DESC_MAX)}` : "";
    return `${ref} | ${clean(p.name, 80)} | ${clean(p.category, 30)}${grade}${strain}${badge} | ${money(prod.price)}${per}${sale}${desc}`;
  });
  return {
    prompt: lines.length
      ? `IN-STOCK MENU RIGHT NOW (ref | name | category / grade; strain label | price). Recommend ONLY from this list, by ref:\n${lines.join("\n")}`
      : "IN-STOCK MENU RIGHT NOW: nothing is available to order online at the moment. Do not recommend products; suggest checking back later or visiting the shop.",
    byRef,
    size: lines.length,
  };
}
