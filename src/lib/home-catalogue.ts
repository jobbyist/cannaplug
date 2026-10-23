// Homepage catalogue rules (pure): which products are featured and which categories are shown.

export const CATEGORY_ORDER = [
  "Flower",
  "Pre-rolls",
  "Edibles",
  "Drinks",
  "CBD",
  "Vapes",
  "Concentrates",
  "Accessories",
] as const;

export const CATEGORY_TAGLINES: Record<string, string> = {
  Flower: "Premium Strains",
  "Pre-rolls": "Rolled & Ready",
  Edibles: "Gourmet Infusions",
  Drinks: "Infused & Refreshing",
  CBD: "Calm & Balance",
  Vapes: "Discreet & Smooth",
  Concentrates: "Pure Potency",
  Accessories: "Tools & Essentials",
};
export const taglineFor = (category: string) => CATEGORY_TAGLINES[category] ?? "Explore the range";

export type HomeProduct = {
  id: string;
  slug: string;
  name: string;
  category: string;
  subcategory: string | null;
  price_rand: number;
  regular_price_rand: number | null;
  unit: string | null;
  badge: string | null;
  sold_by_weight: boolean;
  image_url: string | null;
  is_featured: boolean;
  sort_order: number;
  in_stock: boolean;
};

export const FEATURED_MAX = 8;

/** Picked products first (in stock, by sort order); topped up with in-stock products, one per category first. */
export function pickFeatured(products: HomeProduct[], max = FEATURED_MAX): HomeProduct[] {
  const stocked = products.filter((p) => p.in_stock);
  const bySort = (a: HomeProduct, b: HomeProduct) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name);
  const picked = stocked
    .filter((p) => p.is_featured)
    .sort(bySort)
    .slice(0, max);
  if (picked.length >= max) return picked;
  const chosen = new Set(picked.map((p) => p.id));
  const rest = stocked.filter((p) => !chosen.has(p.id)).sort(bySort);
  const out = [...picked];
  for (const cat of CATEGORY_ORDER) {
    if (out.length >= max) break;
    if (out.some((p) => p.category === cat)) continue;
    const first = rest.find((p) => p.category === cat && !out.includes(p));
    if (first) out.push(first);
  }
  for (const p of rest) {
    if (out.length >= max) break;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Categories that have at least one in-stock online product, in the shop's order. */
export function visibleCategories(products: HomeProduct[]) {
  const counts = new Map<string, number>();
  for (const p of products)
    if (p.in_stock) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const known = CATEGORY_ORDER.filter((c) => counts.has(c));
  const extra = [...counts.keys()]
    .filter((c) => !(CATEGORY_ORDER as readonly string[]).includes(c))
    .sort();
  return [...known, ...extra].map((name) => ({
    name,
    tagline: taglineFor(name),
    count: counts.get(name)!,
  }));
}
