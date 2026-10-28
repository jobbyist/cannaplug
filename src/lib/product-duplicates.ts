// Possible duplicate products: pure matching shared by the CSV planner, the product editor check and the tests.
// A warning never blocks a save: the manager decides. Matches are on the same name and category, or a SKU that is
// the same once case and punctuation are ignored (OCS(001 and OCS-001 are one code written two ways).

export type DuplicateCandidate = {
  id?: string | null;
  name?: string | null;
  category?: string | null;
  sku?: string | null;
};
export type DuplicatePool = {
  id: string;
  name: string;
  category: string;
  sku: string | null;
  is_active: boolean;
};
export type DuplicateMatch = {
  id: string;
  name: string;
  category: string;
  sku: string | null;
  is_active: boolean;
  reason: "same_name" | "similar_sku";
};

/** Lower case, accents and punctuation removed, spaces collapsed: "Mandarin  Cookies (Greendoor)" → "mandarin cookies greendoor". */
export const normaliseName = (v: string | null | undefined): string =>
  (v ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Letters and digits only: "OCS(001" and "ocs-001" are the same code. */
export const normaliseSku = (v: string | null | undefined): string =>
  (v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Products in the pool that look like the candidate (never the candidate itself, and never the same exact SKU). */
export function findDuplicates(c: DuplicateCandidate, pool: DuplicatePool[]): DuplicateMatch[] {
  const name = normaliseName(c.name);
  const category = (c.category ?? "").trim().toLowerCase();
  const sku = normaliseSku(c.sku);
  const out: DuplicateMatch[] = [];
  for (const p of pool) {
    if (c.id && p.id === c.id) continue;
    const exactSku =
      !!c.sku && !!p.sku && c.sku.trim().toLowerCase() === p.sku.trim().toLowerCase();
    if (exactSku) continue; // the same SKU is the same product (an update), not a duplicate
    const reason: DuplicateMatch["reason"] | null =
      name && normaliseName(p.name) === name && p.category.trim().toLowerCase() === category
        ? "same_name"
        : sku.length >= 3 && normaliseSku(p.sku) === sku
          ? "similar_sku"
          : null;
    if (reason)
      out.push({
        id: p.id,
        name: p.name,
        category: p.category,
        sku: p.sku,
        is_active: p.is_active,
        reason,
      });
  }
  return out;
}

/** One sentence a manager can act on. */
export function describeDuplicate(m: DuplicateMatch): string {
  const what = `${m.name}${m.sku ? ` (${m.sku})` : " (no SKU)"} in ${m.category}${m.is_active ? "" : ", hidden"}`;
  return m.reason === "same_name"
    ? `Same name and category as ${what}.`
    : `SKU is the same as ${what} apart from punctuation or case.`;
}
