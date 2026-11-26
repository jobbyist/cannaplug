/**
 * Pure filter logic for /admin → Products: search, active/inactive, category, subcategory and "out of stock".
 * Stock comes from the Inventory list (same rule as the Inventory tab: tracked and nothing available).
 */
import { CATEGORY_ORDER, SUBCATEGORY_ORDER, normKey, orderBy } from "@/lib/catalogue-taxonomy";
import { stockStatus, type InventoryRow } from "@/lib/inventory-logic";

export type ProductStatusFilter = "all" | "active" | "inactive";

export type ProductFilters = {
  q: string;
  status: ProductStatusFilter;
  category: string; // "" = all
  subcategory: string; // "" = all
  outOfStock: boolean;
};

export const DEFAULT_PRODUCT_FILTERS: ProductFilters = {
  q: "",
  status: "all",
  category: "",
  subcategory: "",
  outOfStock: false,
};

type FilterableProduct = {
  id: string;
  name: string;
  sku: string | null;
  category: string;
  subcategory: string | null;
  brand?: string | null;
  is_active: boolean;
};

/** Ids of products that are tracked and have nothing available (what Inventory calls "Out of stock"). */
export function outOfStockIds(stock: InventoryRow[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const r of stock ?? []) if (stockStatus(r) === "out") ids.add(r.product_id);
  return ids;
}

export function filterProducts<T extends FilterableProduct>(
  products: T[],
  f: ProductFilters,
  outIds: Set<string>,
): T[] {
  const needle = f.q.trim().toLowerCase();
  const cat = normKey(f.category);
  const sub = normKey(f.subcategory);
  return products.filter((p) => {
    if (f.status === "active" && !p.is_active) return false;
    if (f.status === "inactive" && p.is_active) return false;
    if (cat && normKey(p.category) !== cat) return false;
    if (sub && normKey(p.subcategory) !== sub) return false;
    if (f.outOfStock && !outIds.has(p.id)) return false;
    if (needle) {
      const hay =
        `${p.name} ${p.sku ?? ""} ${p.brand ?? ""} ${p.category} ${p.subcategory ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Categories in the products, shop order first then A to Z. */
export function productCategories(products: Pick<FilterableProduct, "category">[]): string[] {
  const seen = new Map<string, string>();
  for (const p of products)
    if (p.category && !seen.has(normKey(p.category))) seen.set(normKey(p.category), p.category);
  return orderBy([...seen.values()], CATEGORY_ORDER);
}

/** Subcategories used by products in `category` (all categories when empty), grade order first then A to Z. */
export function productSubcategories(
  products: Pick<FilterableProduct, "category" | "subcategory">[],
  category: string,
): string[] {
  const cat = normKey(category);
  const seen = new Map<string, string>();
  for (const p of products) {
    if (!p.subcategory) continue;
    if (cat && normKey(p.category) !== cat) continue;
    if (!seen.has(normKey(p.subcategory))) seen.set(normKey(p.subcategory), p.subcategory);
  }
  const known = cat
    ? (Object.entries(SUBCATEGORY_ORDER).find(([k]) => normKey(k) === cat)?.[1] ?? [])
    : Object.values(SUBCATEGORY_ORDER).flat();
  return orderBy([...seen.values()], known);
}
