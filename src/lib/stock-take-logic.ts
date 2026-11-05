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
