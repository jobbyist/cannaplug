// Catalogue import (Yoco POS export and plain CSV): pure parsing and mapping, shared by the server and the tests.
// Nothing here touches the database; import_catalogue() in SQL is the authority on what gets written.

export type ImportRow = {
  sku: string;
  name: string;
  slug: string;
  category: string;
  brand: string | null;
  price: string;
  cost: string | null;
  unit: string | null;
  sold_by_weight: boolean;
  opening_qty: number;
  track_stock: boolean;
  sell_online: boolean;
};
export type ImportIssue = { line: number; name: string; problem: string };
export type ParsedImport = { rows: ImportRow[]; issues: ImportIssue[]; notes: string[] };

/** Yoco categories → Cannaplug categories (owner-approved 23 Oct 2026; client confirmation pending). */
export const YOCO_CATEGORY_MAP: Record<string, string> = {
  flower: "Flower",
  sticks: "Pre-rolls",
  "pre-rolls": "Pre-rolls",
  edibles: "Edibles",
  drinks: "Drinks",
  cbd: "CBD",
  accessories: "Accessories",
  "air mechanism": "Vapes",
  vapes: "Vapes",
  concentrate: "Concentrates",
  concentrates: "Concentrates",
  lounge: "Lounge",
};
/** Categories that are services sold in the shop only: never online, no physical stock. */
export const IN_STORE_ONLY_CATEGORIES = new Set(["Lounge"]);
/** Rows the export left without a category, decided by the owner on 23 Oct 2026. */
export const CATEGORY_OVERRIDES_BY_NAME: Record<string, string> = {
  "300mg cbd teddies": "Edibles",
  "rhodes fruit juice orange": "Drinks",
};

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF, and Excel's leading `sep=,` line. */
export function parseCsv(text: string): string[][] {
  let src = text.replace(/^\uFEFF/, "");
  let sep = ",";
  const m = /^sep=(.)\r?\n/.exec(src);
  if (m) {
    sep = m[1]!;
    src = src.slice(m[0].length);
  }
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) out.push(row);
  return out;
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

/** "R1 250,00", "1250.00", "1,250.00", "35" → "1250.00" style strings; null when not a number. */
export function normaliseRand(v: string | undefined | null): string | null {
  const raw = (v ?? "").trim().replace(/^R\s*/i, "").replace(/\s/g, "");
  if (!raw) return null;
  let s = raw;
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s).toFixed(2);
}

export const isYocoExport = (header: string[]) =>
  ["Product ID", "Product Name", "Default Price", "SKU", "Track Stock"].every((h) =>
    header.includes(h),
  );

/** Maps a Yoco POS product export to import rows. Opening stock = Default Quantity (owner decision, 23 Oct 2026). */
export function mapYocoExport(table: string[][]): ParsedImport {
  const [header, ...body] = table;
  const issues: ImportIssue[] = [];
  const notes: string[] = [];
  if (!header || !isYocoExport(header)) {
    return {
      rows: [],
      issues: [{ line: 1, name: "", problem: "This is not a Yoco product export." }],
      notes,
    };
  }
  const col = (r: string[], name: string) => (r[header.indexOf(name)] ?? "").trim();
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  body.forEach((r, i) => {
    const line = i + 2;
    const name = col(r, "Product Name");
    const sku = col(r, "SKU");
    if (!name) return issues.push({ line, name, problem: "Missing product name" });
    if (!sku) return issues.push({ line, name, problem: "Missing SKU" });
    if (seen.has(sku.toLowerCase()))
      return issues.push({ line, name, problem: `Duplicate SKU ${sku}` });
    if (col(r, "Variant Enabled") || col(r, "Attribute 1"))
      return issues.push({ line, name, problem: "Has variants: not supported in this import" });
    const price = normaliseRand(col(r, "Default Price"));
    if (price === null) return issues.push({ line, name, problem: "Price is not a number" });
    const costRaw = col(r, "Default Cost Price");
    const cost = costRaw ? normaliseRand(costRaw) : null;
    if (costRaw && cost === null)
      return issues.push({ line, name, problem: "Cost price is not a number" });
    const yocoCat = col(r, "Category");
    const category =
      CATEGORY_OVERRIDES_BY_NAME[name.toLowerCase()] ?? YOCO_CATEGORY_MAP[yocoCat.toLowerCase()];
    if (!category)
      return issues.push({ line, name, problem: `Unknown category "${yocoCat || "(blank)"}"` });
    if (!yocoCat) notes.push(`${name}: no category in Yoco, imported as ${category}`);
    const inStoreOnly = IN_STORE_ONLY_CATEGORIES.has(category);
    const trackStock = !inStoreOnly && col(r, "Track Stock").toLowerCase() !== "no";
    const qtyRaw = col(r, "Default Quantity");
    const qty = qtyRaw ? Number(qtyRaw) : 0;
    if (!Number.isFinite(qty) || qty < 0)
      return issues.push({ line, name, problem: "Default Quantity is not a number" });
    if (qty !== Math.floor(qty))
      notes.push(`${name}: opening stock ${qtyRaw} rounded down to ${Math.floor(qty)}`);
    const byWeight =
      col(r, "Ask For Quantity").toLowerCase() === "yes" &&
      col(r, "Quantity Units").toLowerCase() === "g";
    const yocoId = col(r, "Product ID");
    const fromName = slugify(name);
    // Yoco keeps a product's original slug after a rename (e.g. gorilla-zskittles-top-shelf is now "Candyland").
    const slug = yocoId === fromName ? yocoId : fromName;
    seen.add(sku.toLowerCase());
    rows.push({
      sku,
      name,
      slug,
      category,
      brand: col(r, "Brand") || null,
      price,
      cost,
      unit: byWeight ? "g" : col(r, "Quantity Units") || null,
      sold_by_weight: byWeight,
      opening_qty: trackStock ? Math.floor(qty) : 0,
      track_stock: trackStock,
      sell_online: !inStoreOnly,
    });
    return undefined;
  });
  return { rows, issues, notes };
}

export function summariseImport(p: ParsedImport) {
  const byCategory: Record<string, number> = {};
  let units = 0;
  let stockValue = 0;
  for (const r of p.rows) {
    byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    units += r.opening_qty;
    stockValue += r.opening_qty * Number(r.price);
  }
  return {
    products: p.rows.length,
    byCategory,
    stocked: p.rows.filter((r) => r.opening_qty > 0).length,
    openingUnits: units,
    openingRetailValue: Math.round(stockValue * 100) / 100,
    weighed: p.rows.filter((r) => r.sold_by_weight).length,
    inStoreOnly: p.rows.filter((r) => !r.sell_online).length,
    issues: p.issues.length,
  };
}
