/**
 * Pure logic for /admin → Inventory: status, filters, sorting, summary counts, batch-code suggestions and the
 * adjustment preview. Shared by the panel and its tests; nothing here touches the database.
 */

export type StockStatus = "out" | "low" | "ok" | "untracked";

export type InventoryRow = {
  product_id: string;
  name: string;
  sku: string | null;
  category: string;
  brand: string | null;
  unit: string | null;
  sold_by_weight: boolean;
  is_active: boolean;
  sell_online: boolean;
  track_stock: boolean;
  low_stock_threshold: number;
  price_rand: number;
  regular_price_rand: number | null;
  image_url: string | null;
  on_hand: number;
  held: number;
  available: number;
  expired: number;
  batches: number;
  /** Earliest expiry among batches that still have stock (ISO), or null. */
  next_expiry: string | null;
  /** On-hand stock at cost, managers only (null for budtenders or when cost is unknown). */
  stock_value: number | null;
};

export function stockStatus(
  r: Pick<InventoryRow, "track_stock" | "available" | "low_stock_threshold">,
) {
  if (!r.track_stock) return "untracked" as const;
  if (r.available <= 0) return "out" as const;
  if (r.available <= r.low_stock_threshold) return "low" as const;
  return "ok" as const;
}

export const STATUS_LABEL: Record<StockStatus, string> = {
  out: "Out of stock",
  low: "Low stock",
  ok: "In stock",
  untracked: "Not tracked",
};

const DAY = 86_400_000;
export const EXPIRY_WARNING_DAYS = 30;

export function expiresSoon(r: Pick<InventoryRow, "next_expiry">, now = new Date()): boolean {
  if (!r.next_expiry) return false;
  const t = new Date(r.next_expiry).getTime();
  return t > now.getTime() && t - now.getTime() <= EXPIRY_WARNING_DAYS * DAY;
}

export type StatusFilter = "all" | StockStatus | "expiring" | "expired";
export type SortKey = "attention" | "name" | "available_asc" | "available_desc" | "category";

export type InventoryFilters = {
  q: string;
  category: string; // "" = all
  status: StatusFilter;
  sort: SortKey;
  showInactive: boolean;
};

export const DEFAULT_FILTERS: InventoryFilters = {
  q: "",
  category: "",
  status: "all",
  sort: "attention",
  showInactive: false,
};

const RANK: Record<StockStatus, number> = { out: 0, low: 1, ok: 2, untracked: 3 };

export function filterInventory(
  rows: InventoryRow[],
  f: InventoryFilters,
  now = new Date(),
): InventoryRow[] {
  const needle = f.q.trim().toLowerCase();
  const out = rows.filter((r) => {
    if (!f.showInactive && !r.is_active) return false;
    if (f.category && r.category !== f.category) return false;
    if (needle) {
      const hay = `${r.name} ${r.sku ?? ""} ${r.brand ?? ""} ${r.category}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    switch (f.status) {
      case "all":
        return true;
      case "expiring":
        return expiresSoon(r, now);
      case "expired":
        return r.expired > 0;
      default:
        return stockStatus(r) === f.status;
    }
  });
  const byName = (a: InventoryRow, b: InventoryRow) => a.name.localeCompare(b.name);
  const sorters: Record<SortKey, (a: InventoryRow, b: InventoryRow) => number> = {
    attention: (a, b) =>
      RANK[stockStatus(a)] - RANK[stockStatus(b)] || a.available - b.available || byName(a, b),
    name: byName,
    available_asc: (a, b) => a.available - b.available || byName(a, b),
    available_desc: (a, b) => b.available - a.available || byName(a, b),
    category: (a, b) => a.category.localeCompare(b.category) || byName(a, b),
  };
  return out.sort(sorters[f.sort]);
}

export type InventorySummaryCounts = {
  products: number;
  out: number;
  low: number;
  expiring: number;
  expired: number;
  units: number;
  held: number;
  value: number | null;
};

/** Counts over active, tracked products (the ones staff manage stock for). */
export function summarise(rows: InventoryRow[], now = new Date()): InventorySummaryCounts {
  const live = rows.filter((r) => r.is_active && r.track_stock);
  const values = live.map((r) => r.stock_value);
  return {
    products: live.length,
    out: live.filter((r) => stockStatus(r) === "out").length,
    low: live.filter((r) => stockStatus(r) === "low").length,
    expiring: live.filter((r) => expiresSoon(r, now)).length,
    expired: live.filter((r) => r.expired > 0).length,
    units: live.reduce((s, r) => s + r.on_hand, 0),
    held: live.reduce((s, r) => s + r.held, 0),
    value: values.some((v) => v != null) ? values.reduce<number>((s, v) => s + (v ?? 0), 0) : null,
  };
}

export function categoriesOf(rows: InventoryRow[]): string[] {
  return [...new Set(rows.map((r) => r.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** "KUSH-271026": SKU (or the first letters of the name) plus today's date, for a new delivery's batch. */
export function suggestBatchCode(
  r: Pick<InventoryRow, "sku" | "name">,
  today = new Date(),
): string {
  const base =
    (r.sku ?? "")
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 10) ||
    r.name
      .replace(/[^A-Za-z0-9 ]/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 6) ||
    "BATCH";
  const d = today;
  const stamp = `${String(d.getDate()).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getFullYear()).slice(2)}`;
  return `${base}-${stamp}`;
}

/** Why staff change stock by hand. "other" needs a note. */
export const ADJUST_REASONS = [
  { value: "count", label: "Stock count correction" },
  { value: "damaged", label: "Damaged" },
  { value: "expired", label: "Expired" },
  { value: "loss", label: "Lost or stolen" },
  { value: "supplier_return", label: "Returned to supplier" },
  { value: "sample", label: "Sample or testing" },
  { value: "found", label: "Found stock" },
  { value: "other", label: "Other (explain)" },
] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number]["value"];

export type AdjustMode = "remove" | "add" | "count";

/**
 * The change an adjustment makes to one batch. "count" sets the batch to the number counted. Returns the delta,
 * the result and a problem when the change is not allowed (never below zero or below what online orders hold).
 */
export function adjustmentPreview(input: {
  mode: AdjustMode;
  amount: number;
  batchOnHand: number;
  batchHeld: number;
}): { delta: number; after: number; problem: string | null } {
  const { mode, batchOnHand, batchHeld } = input;
  const amount = Number.isFinite(input.amount) ? Math.trunc(input.amount) : NaN;
  if (!Number.isFinite(amount) || amount < 0)
    return { delta: 0, after: batchOnHand, problem: "Enter a whole number." };
  const delta = mode === "add" ? amount : mode === "remove" ? -amount : amount - batchOnHand;
  const after = batchOnHand + delta;
  if (delta === 0)
    return {
      delta,
      after,
      problem:
        mode === "count"
          ? "That matches what the system has. Nothing to change."
          : "Enter a quantity.",
    };
  if (after < 0) return { delta, after, problem: `This batch only has ${batchOnHand} on hand.` };
  if (after < batchHeld)
    return {
      delta,
      after,
      problem: `${batchHeld} of this batch ${batchHeld === 1 ? "is" : "are"} held for online orders. Stock can't go below that.`,
    };
  return { delta, after, problem: null };
}

/** The reason text written to the stock ledger and audit log (3-300 characters). */
export function adjustmentReasonText(reason: AdjustReason, note: string): string | null {
  const label = ADJUST_REASONS.find((r) => r.value === reason)?.label ?? "Adjustment";
  const n = note.trim();
  if (reason === "other") return n.length >= 3 ? n.slice(0, 300) : null;
  return (n ? `${label}: ${n}` : label).slice(0, 300);
}

export const MOVEMENT_LABEL: Record<string, string> = {
  receipt: "Stock received",
  adjustment: "Manual adjustment",
  online_sale: "Online sale",
  online_cancel_restock: "Online order cancelled",
  pos_sale: "Till sale",
  pos_void_restock: "Till sale voided",
  pos_refund_restock: "Till refund",
};

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Stock sheet for a count or a supplier order: what is on screen, as CSV. No cost data. */
export function inventoryCsv(rows: InventoryRow[]): string {
  const head = [
    "sku",
    "name",
    "category",
    "brand",
    "status",
    "available",
    "held",
    "on_hand",
    "low_stock_alert",
    "next_expiry",
    "counted",
  ];
  const lines = rows.map((r) =>
    [
      r.sku,
      r.name,
      r.category,
      r.brand,
      STATUS_LABEL[stockStatus(r)],
      r.available,
      r.held,
      r.on_hand,
      r.low_stock_threshold,
      r.next_expiry ? r.next_expiry.slice(0, 10) : "",
      "",
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n");
}
