import type { InventoryRow } from "@/lib/inventory-logic";

/** Pure helpers for stock takes, quick add / remove and deliveries (no I/O; the screens and tests share them). */

export type CountLine = {
  product_id: string;
  name: string;
  category: string;
  expected: number;
  counted: number;
  difference: number;
  unit_cost: number | null;
};

/**
 * What a scanned or typed value points at. A USB barcode scanner types the code and presses Enter, so an exact
 * barcode or SKU wins outright; otherwise products whose name contains every word typed, best first.
 */
export function findProducts(rows: InventoryRow[], query: string, limit = 8): InventoryRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = rows.filter(
    (r) => (r.barcode ?? "").toLowerCase() === q || (r.sku ?? "").toLowerCase() === q,
  );
  if (exact.length) return exact.slice(0, limit);
  const words = q.split(/\s+/);
  return rows
    .filter((r) => words.every((w) => r.name.toLowerCase().includes(w)))
    .sort((a, b) => {
      const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

/** Products a count should cover: tracked stock, optionally one category. */
export function countableProducts(rows: InventoryRow[], category: string | null): InventoryRow[] {
  return rows.filter((r) => r.track_stock && (!category || r.category === category));
}

export type VarianceSummary = {
  counted: number;
  changed: number;
  unitsOver: number;
  unitsUnder: number;
  /** At cost; null when no counted product with a difference has a cost. */
  valueOver: number | null;
  valueUnder: number | null;
};

export function varianceSummary(lines: CountLine[]): VarianceSummary {
  let unitsOver = 0;
  let unitsUnder = 0;
  let valueOver: number | null = null;
  let valueUnder: number | null = null;
  let changed = 0;
  for (const l of lines) {
    if (l.difference === 0) continue;
    changed++;
    if (l.difference > 0) {
      unitsOver += l.difference;
      if (l.unit_cost != null) valueOver = (valueOver ?? 0) + l.difference * l.unit_cost;
    } else {
      unitsUnder -= l.difference;
      if (l.unit_cost != null) valueUnder = (valueUnder ?? 0) - l.difference * l.unit_cost;
    }
  }
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    counted: lines.length,
    changed,
    unitsOver,
    unitsUnder,
    valueOver: round(valueOver),
    valueUnder: round(valueUnder),
  };
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The count as a spreadsheet: one row per counted product, biggest differences first. */
export function countCsv(lines: CountLine[]): string {
  const head = ["Product", "Category", "System", "Counted", "Difference", "Unit cost", "Value"];
  const body = [...lines]
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.name.localeCompare(b.name))
    .map((l) => [
      l.name,
      l.category,
      l.expected,
      l.counted,
      l.difference,
      l.unit_cost ?? "",
      l.unit_cost == null ? "" : (Math.round(l.difference * l.unit_cost * 100) / 100).toFixed(2),
    ]);
  return [head, ...body].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export const ADD_REASONS = ["Found in store", "Returned by customer", "Count correction"] as const;
export const REMOVE_REASONS = [
  "Damaged",
  "Expired",
  "Returned to supplier",
  "Used as sample",
  "Count correction",
] as const;

// ---------------------------------------------------------------- count sheet (CSV upload)

/**
 * Count sheet for a stock take: one row per product in the count, with an empty "counted" column to fill in on paper
 * or in Excel / Google Sheets. Blind like the screen count: the system quantity is not on the sheet. The same upload
 * also reads the Inventory tab's "Stock sheet" (it has sku, name and counted too).
 */
export function countSheetCsv(rows: InventoryRow[]): string {
  const head = ["sku", "barcode", "name", "category", "unit", "counted"];
  const body = [...rows]
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .map((r) => [
      r.sku ?? "",
      r.barcode ?? "",
      r.name,
      r.category,
      r.sold_by_weight ? "grams" : (r.unit ?? "units"),
      "",
    ]);
  // BOM so Excel opens it as UTF-8.
  return "\uFEFF" + [head, ...body].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Splits CSV text into rows. Handles quotes, CRLF, a BOM and Excel's semicolon-separated files (some SA locales). */
export function parseCountCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type CountUploadLine = {
  line: number;
  product_id: string;
  name: string;
  counted: number;
  /** Already counted in this stock take (the upload replaces that number). */
  previous: number | null;
};
export type CountUploadIssue = { line: number; label: string; problem: string };
export type CountUploadPlan = {
  lines: CountUploadLine[];
  issues: CountUploadIssue[];
  /** Rows left blank in the counted column (not counted; left alone). */
  blank: number;
  /** Rows whose number is the same as the one already saved in this count. */
  unchanged: number;
};

const MAX_COUNT_ROWS = 3000;
const norm = (v: string) =>
  v
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase();
const headerKey = (h: string) => norm(h).replace(/[\s-]+/g, "_");
const COUNT_HEADERS = ["counted", "count", "counted_qty", "qty_counted", "quantity_counted"];

/**
 * Reads an uploaded count sheet against the products in the open count. Rows are matched by SKU, then barcode, then
 * exact name. A blank "counted" cell means not counted. Nothing is saved here: the screen shows this plan first.
 */
export function planCountUpload(
  text: string,
  scope: InventoryRow[],
  alreadyCounted: ReadonlyMap<string, number>,
): CountUploadPlan {
  const issues: CountUploadIssue[] = [];
  const empty = { lines: [], blank: 0, unchanged: 0 };
  const table = parseCountCsv(text);
  const [header, ...body] = table;
  if (!header) return { ...empty, issues: [{ line: 1, label: "", problem: "The file is empty." }] };
  const keys = header.map(headerKey);
  const col = (names: string[]) => keys.findIndex((k) => names.includes(k));
  const iCount = col(COUNT_HEADERS);
  const iSku = col(["sku"]);
  const iBarcode = col(["barcode"]);
  const iName = col(["name", "product", "product_name"]);
  if (iCount < 0)
    return {
      ...empty,
      issues: [{ line: 1, label: "", problem: 'The file needs a "counted" column.' }],
    };
  if (iSku < 0 && iBarcode < 0 && iName < 0)
    return {
      ...empty,
      issues: [
        {
          line: 1,
          label: "",
          problem: 'The file needs a "sku", "barcode" or "name" column to know which product.',
        },
      ],
    };
  if (body.length > MAX_COUNT_ROWS)
    return {
      ...empty,
      issues: [{ line: 1, label: "", problem: `The file has more than ${MAX_COUNT_ROWS} rows.` }],
    };

  const bySku = new Map<string, InventoryRow>();
  const byBarcode = new Map<string, InventoryRow>();
  const byName = new Map<string, InventoryRow[]>();
  for (const r of scope) {
    if (r.sku) bySku.set(norm(r.sku), r);
    if (r.barcode) byBarcode.set(norm(r.barcode), r);
    const n = norm(r.name);
    byName.set(n, [...(byName.get(n) ?? []), r]);
  }

  // Excel's formula guard (a leading ') must not stop a SKU matching.
  const cellAt = (r: string[], i: number) =>
    i < 0 ? "" : (r[i] ?? "").trim().replace(/^'(?=[=+\-@])/, "");
  const lines: CountUploadLine[] = [];
  const seen = new Map<string, number>();
  let blank = 0;
  let unchanged = 0;
  body.forEach((r, idx) => {
    const line = idx + 2;
    const sku = cellAt(r, iSku);
    const barcode = cellAt(r, iBarcode);
    const name = cellAt(r, iName);
    const label = name || sku || barcode;
    const raw = cellAt(r, iCount).replace(/\s/g, "");
    if (raw === "") {
      blank++;
      return undefined;
    }
    const bad = (problem: string) => issues.push({ line, label, problem });
    let product: InventoryRow | undefined;
    if (sku) product = bySku.get(norm(sku));
    if (!product && barcode) product = byBarcode.get(norm(barcode));
    if (!product && name) {
      const hits = byName.get(norm(name)) ?? [];
      if (hits.length > 1)
        return bad("Two products in this count have this name. Add the SKU or barcode.");
      product = hits[0];
    }
    if (!product)
      return bad(
        sku || barcode || name
          ? "Not a product in this count (check the SKU, or that it belongs to the category being counted)."
          : "No SKU, barcode or name on this row.",
      );
    // Whole numbers only; "12.0" or "12,0" from a spreadsheet is fine.
    const m = /^(\d{1,7})(?:[.,]0+)?$/.exec(raw);
    if (!m) return bad(`"${raw}" is not a whole number (0 if there are none).`);
    const counted = Number(m[1]);
    if (counted > 1_000_000) return bad("That is more than 1,000,000.");
    const dup = seen.get(product.product_id);
    if (dup) return bad(`${product.name} is also on line ${dup}. Keep one row per product.`);
    seen.set(product.product_id, line);
    const previous = alreadyCounted.get(product.product_id) ?? null;
    if (previous === counted) {
      unchanged++;
      return undefined;
    }
    lines.push({ line, product_id: product.product_id, name: product.name, counted, previous });
    return undefined;
  });
  return { lines, issues, blank, unchanged };
}
