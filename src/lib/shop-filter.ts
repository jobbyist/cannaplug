// The /shop filter (pure): what the address bar can say, which products match, how many match each choice, and the order
// they are shown in. The page keeps no filter state of its own: it reads the address bar and writes the address bar, so a
// filtered view can be shared, bookmarked and reached with the back button.
import { CATEGORY_ORDER, SUBCATEGORY_ORDER, normKey, orderBy } from "@/lib/catalogue-taxonomy";

export type ShopProduct = {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  strain_type: string | null;
  description: string | null;
  price_rand: number | string;
  regular_price_rand: number | string | null;
  in_stock: boolean;
};

export const SORTS = ["featured", "price-asc", "price-desc", "name"] as const;
export type ShopSort = (typeof SORTS)[number];
export const SORT_LABEL: Record<ShopSort, string> = {
  featured: "Featured",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  name: "Name: A to Z",
};

export const STRAINS = ["Indica", "Sativa", "Hybrid"] as const;
export type Strain = (typeof STRAINS)[number];

/** What the address bar can carry. A choice left at its default is left out, so /shop stays /shop. */
export type ShopSearch = {
  category?: string;
  sub?: string;
  strain?: Strain;
  q?: string;
  sort?: Exclude<ShopSort, "featured">;
  min?: number;
  max?: number;
  stock?: true;
  sale?: true;
};

const flag = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
const amount = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n) : undefined;
};

/** The strain a product's free-text strain field means ("Sativa-dominant" is Sativa), or null. */
export function strainOf(value: string | null | undefined): Strain | null {
  const k = normKey(value);
  return STRAINS.find((s) => k.startsWith(normKey(s))) ?? null;
}

/** Anything the address bar might hold, cleaned into a ShopSearch. Unknown or empty parts are dropped. */
export function parseShopSearch(raw: Record<string, unknown>): ShopSearch {
  const category = text(raw["category"], 60);
  const sub = text(raw["sub"], 60);
  const strain = strainOf(text(raw["strain"], 30));
  const q = text(raw["q"], 80);
  const sort = SORTS.find((s) => s === raw["sort"]);
  const min = amount(raw["min"]);
  const max = amount(raw["max"]);
  return {
    ...(category ? { category } : {}),
    ...(sub ? { sub } : {}),
    ...(strain ? { strain } : {}),
    ...(q ? { q } : {}),
    ...(sort && sort !== "featured" ? { sort } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(flag(raw["stock"]) ? { stock: true as const } : {}),
    ...(flag(raw["sale"]) ? { sale: true as const } : {}),
  };
}

const priceOf = (p: ShopProduct) => Number(p.price_rand);
const onSale = (p: ShopProduct) =>
  p.regular_price_rand != null && Number(p.regular_price_rand) > priceOf(p);

type Facet = "category" | "sub" | "strain" | "price" | "stock" | "sale" | "q";

/** The categories on sale, in the shop's order (known ones first, then any others A to Z). */
export function categoryNames(products: ShopProduct[]): string[] {
  return orderBy(
    products.map((p) => p.category),
    CATEGORY_ORDER,
  );
}

export function subcategoryNames(products: ShopProduct[], category: string): string[] {
  const inCategory = products.filter((p) => normKey(p.category) === normKey(category));
  const known =
    Object.entries(SUBCATEGORY_ORDER).find(([c]) => normKey(c) === normKey(category))?.[1] ?? [];
  return orderBy(
    inCategory.flatMap((p) => (p.subcategory ? [p.subcategory] : [])),
    known,
  );
}

/**
 * The search with every choice resolved against what is really on sale: a category or subcategory is matched without
 * regard to case and spelled the way the shop spells it, one that doesn't exist is dropped, and a price range is kept
 * inside the prices that exist.
 */
export function resolveShopSearch(search: ShopSearch, products: ShopProduct[]): ShopSearch {
  const out: ShopSearch = { ...search };
  const categories = categoryNames(products);
  const category = search.category
    ? categories.find((c) => normKey(c) === normKey(search.category))
    : undefined;
  if (category) out.category = category;
  else delete out.category;
  const sub =
    category && search.sub
      ? subcategoryNames(products, category).find((s) => normKey(s) === normKey(search.sub))
      : undefined;
  if (sub) out.sub = sub;
  else delete out.sub;
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    const lo = out.max;
    out.max = out.min;
    out.min = lo;
  }
  return out;
}

export function matches(p: ShopProduct, s: ShopSearch, skip: Facet[] = []): boolean {
  if (!skip.includes("category") && s.category && normKey(p.category) !== normKey(s.category))
    return false;
  if (!skip.includes("sub") && s.sub && normKey(p.subcategory) !== normKey(s.sub)) return false;
  if (!skip.includes("strain") && s.strain && strainOf(p.strain_type) !== s.strain) return false;
  if (!skip.includes("stock") && s.stock && !p.in_stock) return false;
  if (!skip.includes("sale") && s.sale && !onSale(p)) return false;
  if (!skip.includes("price")) {
    if (s.min !== undefined && priceOf(p) < s.min) return false;
    if (s.max !== undefined && priceOf(p) > s.max) return false;
  }
  if (!skip.includes("q") && s.q) {
    const hay = normKey(`${p.name} ${p.category} ${p.subcategory ?? ""} ${p.description ?? ""}`);
    if (
      !normKey(s.q)
        .split(" ")
        .every((w) => hay.includes(w))
    )
      return false;
  }
  return true;
}

export const filterProducts = <T extends ShopProduct>(products: T[], s: ShopSearch): T[] =>
  products.filter((p) => matches(p, s));

export type Count = { name: string; count: number };

export type Facets = {
  total: number;
  categories: Count[];
  subcategories: Count[];
  strains: Count[];
  /** Cheapest and dearest of the products that match everything except the price range, in whole rand. */
  price: { min: number; max: number } | null;
  inStock: number;
  onSale: number;
};

/**
 * How many products each choice would show. Each group is counted with every other filter applied but not its own,
 * so choosing a category never makes the other categories read zero.
 */
export function facets(products: ShopProduct[], s: ShopSearch): Facets {
  const count = (names: string[], pick: (p: ShopProduct) => string, skip: Facet[]): Count[] => {
    const pool = products.filter((p) => matches(p, s, skip));
    return names.map((name) => ({
      name,
      count: pool.filter((p) => normKey(pick(p)) === normKey(name)).length,
    }));
  };
  const pricePool = products.filter((p) => matches(p, s, ["price"]));
  const prices = pricePool.map(priceOf);
  return {
    total: products.length,
    categories: count(categoryNames(products), (p) => p.category, ["category", "sub"]),
    subcategories: s.category
      ? count(subcategoryNames(products, s.category), (p) => p.subcategory ?? "", ["sub"])
      : [],
    strains: STRAINS.map((name) => ({
      name,
      count: products.filter((p) => matches(p, s, ["strain"]) && strainOf(p.strain_type) === name)
        .length,
    })),
    price: prices.length
      ? { min: Math.floor(Math.min(...prices)), max: Math.ceil(Math.max(...prices)) }
      : null,
    inStock: products.filter((p) => matches(p, s, ["stock"]) && p.in_stock).length,
    onSale: products.filter((p) => matches(p, s, ["sale"]) && onSale(p)).length,
  };
}

/** Featured keeps the order the shop sends (the owner's order); the others sort by price or name. Stable. */
export function sortProducts<T extends ShopProduct>(
  products: T[],
  sort: ShopSort = "featured",
): T[] {
  type Row = { p: T; i: number };
  const by: Record<ShopSort, (a: Row, b: Row) => number> = {
    featured: (a, b) => a.i - b.i,
    "price-asc": (a, b) => priceOf(a.p) - priceOf(b.p) || a.i - b.i,
    "price-desc": (a, b) => priceOf(b.p) - priceOf(a.p) || a.i - b.i,
    name: (a, b) => a.p.name.localeCompare(b.p.name) || a.i - b.i,
  };
  return products
    .map((p, i) => ({ p, i }))
    .sort(by[sort])
    .map((x) => x.p);
}

/** Changing category clears what depends on it (subcategory and price range) and keeps the rest. */
export function withCategory(s: ShopSearch, category: string | undefined): ShopSearch {
  const { category: _c, sub: _s, min: _min, max: _max, ...rest } = s;
  return { ...rest, ...(category ? { category } : {}) };
}

export type ActiveFilter = { key: Facet; label: string };

/** The filters that are narrowing the list, for the chips above the results (category has its own row). */
export function activeFilters(s: ShopSearch): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  if (s.sub) out.push({ key: "sub", label: s.sub });
  if (s.strain) out.push({ key: "strain", label: s.strain });
  if (s.q) out.push({ key: "q", label: `“${s.q}”` });
  if (s.min !== undefined || s.max !== undefined)
    out.push({
      key: "price",
      label: `R${s.min ?? 0} – ${s.max !== undefined ? `R${s.max}` : "any"}`,
    });
  if (s.stock) out.push({ key: "stock", label: "In stock" });
  if (s.sale) out.push({ key: "sale", label: "On sale" });
  return out;
}

export function withoutFilter(s: ShopSearch, key: Facet): ShopSearch {
  const next = { ...s };
  if (key === "category") delete next.category;
  if (key === "sub") delete next.sub;
  if (key === "strain") delete next.strain;
  if (key === "q") delete next.q;
  if (key === "stock") delete next.stock;
  if (key === "sale") delete next.sale;
  if (key === "price") {
    delete next.min;
    delete next.max;
  }
  return next;
}

/** Page title and description for the current category and subcategory. */
export function shopHeading(s: ShopSearch): { title: string; description: string } {
  const what = [s.sub, s.category].filter(Boolean).join(" ");
  return what
    ? {
        title: `${what} | Shop | CannaPlug`,
        description: `Shop ${what.toLowerCase()} at CannaPlug, Pretoria Central. Delivery and in-store collection for verified adults.`,
      }
    : { title: "Shop | CannaPlug", description: "Browse CannaPlug's curated cannabis catalogue." };
}
