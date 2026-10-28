// The shop's categories and subcategories, in one place (pure). Categories are the product groups on the homepage and in the
// shop; subcategories are the grades inside Flower and Pre-rolls. Matching is case-insensitive, so "top shelf", "Top Shelf"
// and " TOP  SHELF " are the same thing.

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

/** Display order of the subcategories that exist today. Anything else a product carries is shown after these, A to Z. */
export const SUBCATEGORY_ORDER: Record<string, readonly string[]> = {
  Flower: ["Outdoor", "Greenhouse", "Greendoor", "Premium Indoor", "Top Shelf"],
  "Pre-rolls": ["Greenhouse", "Greendoor", "Premium Indoor", "Top Shelf", "Greendoor 2-in-1"],
};

/** Lower case, accents and extra spaces removed: the key two spellings of the same word share. */
export const normKey = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** The spelling used on screen for a category name that matches a known one, else the cleaned input. */
export function canonicalCategory(input: string | null | undefined): string | null {
  const key = normKey(input);
  if (!key) return null;
  return (
    CATEGORY_ORDER.find((c) => normKey(c) === key) ?? String(input).replace(/\s+/g, " ").trim()
  );
}

/** A subcategory as it should be saved: a known grade in its proper spelling, anything else trimmed. Empty becomes null. */
export function canonicalSubcategory(
  category: string | null | undefined,
  input: string | null | undefined,
): string | null {
  const key = normKey(input);
  if (!key) return null;
  const known = SUBCATEGORY_ORDER[canonicalCategory(category) ?? ""] ?? [];
  return known.find((s) => normKey(s) === key) ?? String(input).replace(/\s+/g, " ").trim();
}

/**
 * The grade written in brackets at the end of a Flower or Pre-roll name, e.g. "Purple Fritter (Greenhouse)". The catalogue
 * import wrote the grade into the name, so this is how existing products get their subcategory. "Entry Indoor" is the
 * Premium Indoor tier. Mirrors the back-fill in migration 20261029004000.
 */
export function gradeFromName(name: string): string | null {
  const m = /\(([^()]*)\)\s*$/.exec(name);
  if (!m) return null;
  switch (normKey(m[1])) {
    case "outdoor":
      return "Outdoor";
    case "greenhouse":
      return "Greenhouse";
    case "greendoor":
      return "Greendoor";
    case "entry indoor":
    case "premium indoor":
      return "Premium Indoor";
    case "top shelf":
      return "Top Shelf";
    case "greendoor 2-in-1":
      return "Greendoor 2-in-1";
    default:
      return null;
  }
}

/** Items in the order of `known` first, then the rest A to Z. Duplicates (by key) are dropped. */
export function orderBy(items: string[], known: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const k = normKey(i);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rank = (i: string) => {
    const idx = known.findIndex((k) => normKey(k) === normKey(i));
    return idx === -1 ? known.length : idx;
  };
  return unique.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
