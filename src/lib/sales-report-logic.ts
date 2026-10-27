/** Shapes and pure helpers for sales reports (Overview, Reports tab). Days are South African calendar days. */

export type Money = number | string;
export type SalesReport = {
  from: string;
  to: string;
  generated_at: string;
  total: Money;
  transactions: number;
  average_sale: Money;
  pos: {
    count: number;
    gross: Money;
    refunds: Money;
    refund_count: number;
    voided_count: number;
    voided_total: Money;
    net: Money;
  };
  online: {
    count: number;
    total: Money;
    delivery_fees: Money;
    awaiting_count: number;
    awaiting_total: Money;
    cancelled_count: number;
    pickup_count: number;
  };
  daily: { day: string; pos: Money; online: Money }[];
  hourly: { hour: number; pos: Money; online: Money; count: number }[];
  pos_tenders: Record<string, Money>;
  online_methods: Record<string, Money>;
  products: {
    name: string;
    category: string | null;
    qty: number;
    revenue: Money;
    pos: Money;
    online: Money;
  }[];
  categories: { category: string; qty: number; revenue: Money }[];
  cashiers: { name: string; count: number; total: Money }[];
  recent: {
    channel: "pos" | "online";
    ref: string;
    amount: Money;
    status: string;
    at: string;
    method: string | null;
  }[];
};

export const n = (v: Money | null | undefined) => Number(v ?? 0);

const TZ = "Africa/Johannesburg";
/** YYYY-MM-DD for a moment, in South African time. */
export function sastDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type RangeKey = "today" | "yesterday" | "7d" | "30d" | "month" | "last-month" | "custom";
export const RANGE_LABEL: Record<RangeKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  "last-month": "Last month",
  custom: "Custom",
};

export function rangeFor(key: RangeKey, today: string = sastDay()): { from: string; to: string } {
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "last-month": {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
    default:
      return { from: today, to: today };
  }
}

export const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  eft: "EFT",
  paypal: "PayPal",
  payfast: "PayFast",
  unknown: "Other",
};
export const methodLabel = (m: string | null | undefined) =>
  (m ?? "")
    .split("+")
    .map((x) => METHOD_LABEL[x] ?? x)
    .filter(Boolean)
    .join(" + ") || "—";

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells: unknown[]) => cells.map(csvCell).join(",");

/** The report as a spreadsheet-friendly CSV (summary, days, products, categories, staff). */
export function salesReportCsv(r: SalesReport): string {
  const out: string[] = [];
  out.push(row(["Sales report", `${r.from} to ${r.to}`]));
  out.push(row(["Total sales", n(r.total).toFixed(2)]));
  out.push(row(["Transactions", r.transactions]));
  out.push(row(["Average sale", n(r.average_sale).toFixed(2)]));
  out.push(row(["Till gross", n(r.pos.gross).toFixed(2)]));
  out.push(row(["Till refunds", n(r.pos.refunds).toFixed(2)]));
  out.push(row(["Till net", n(r.pos.net).toFixed(2)]));
  out.push(row(["Online paid", n(r.online.total).toFixed(2)]));
  for (const [k, v] of Object.entries(r.pos_tenders))
    out.push(row([`Till ${methodLabel(k)}`, n(v).toFixed(2)]));
  for (const [k, v] of Object.entries(r.online_methods))
    out.push(row([`Online ${methodLabel(k)}`, n(v).toFixed(2)]));
  out.push("");
  out.push(row(["Day", "Till net", "Online", "Total"]));
  for (const d of r.daily)
    out.push(
      row([
        d.day,
        n(d.pos).toFixed(2),
        n(d.online).toFixed(2),
        (n(d.pos) + n(d.online)).toFixed(2),
      ]),
    );
  out.push("");
  out.push(row(["Product", "Category", "Qty", "Revenue", "Till", "Online"]));
  for (const p of r.products)
    out.push(
      row([
        p.name,
        p.category ?? "",
        p.qty,
        n(p.revenue).toFixed(2),
        n(p.pos).toFixed(2),
        n(p.online).toFixed(2),
      ]),
    );
  out.push("");
  out.push(row(["Category", "Qty", "Revenue"]));
  for (const c of r.categories) out.push(row([c.category, c.qty, n(c.revenue).toFixed(2)]));
  out.push("");
  out.push(row(["Staff (till)", "Sales", "Total"]));
  for (const c of r.cashiers) out.push(row([c.name, c.count, n(c.total).toFixed(2)]));
  return out.join("\n");
}
