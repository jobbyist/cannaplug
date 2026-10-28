import { methodLabel, n, type SalesReport } from "./sales-report-logic";

/**
 * The sales report as a list of tables, shared by the PDF, Word and Excel downloads so all three say exactly the
 * same thing. Money cells are numbers (rand, 2 decimals); renderers format them. No customer data: the report
 * itself carries none (receipt / order numbers, staff names, product names and expense descriptions only).
 */
/** A rand amount (in a money column), plain text, or a count (a number that is never formatted as rand). */
export type Cell = string | number | { count: number };
const count = (v: number): Cell => ({ count: v });
export type ReportTable = {
  title: string;
  columns: string[];
  /** Per column: true when the column holds rand amounts. */
  money: boolean[];
  rows: Cell[][];
  note?: string;
};

const SAST = new Intl.DateTimeFormat("en-ZA", {
  timeZone: "Africa/Johannesburg",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export const sastTime = (iso: string | null | undefined) => (iso ? SAST.format(new Date(iso)) : "");
const SAST_SHORT = new Intl.DateTimeFormat("en-ZA", {
  timeZone: "Africa/Johannesburg",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
export const sastShort = (iso: string | null | undefined) =>
  iso ? SAST_SHORT.format(new Date(iso)) : "";

const r2 = (v: unknown) => Math.round(n(v as number) * 100) / 100;

export function reportTitle(r: SalesReport): string {
  return r.from === r.to ? `Sales report ${r.from}` : `Sales report ${r.from} to ${r.to}`;
}

export function reportFileName(r: SalesReport, ext: "pdf" | "docx" | "xlsx" | "csv"): string {
  return `cannaplug-sales-${r.from}${r.from === r.to ? "" : `-to-${r.to}`}.${ext}`;
}

export function reportTables(r: SalesReport): ReportTable[] {
  const t: ReportTable[] = [];
  const till = r.till;
  const summary: Cell[][] = [
    ["Total sales (till net + online paid)", r2(r.total)],
    ["Transactions", count(r.transactions)],
    ["Average sale", r2(r.average_sale)],
    ["Till sales before discounts", r2(r.pos.before_discounts ?? r.pos.gross)],
    ["Till discounts", r2(r.pos.discounts ?? 0)],
    ["Till sales (after discounts)", r2(r.pos.gross)],
    ["Till refunds", r2(r.pos.refunds)],
    ["Till net", r2(r.pos.net)],
    ["Online sales (paid)", r2(r.online.total)],
    ["Online orders (paid)", count(r.online.count)],
    ["Online delivery fees", r2(r.online.delivery_fees)],
    ["Online awaiting payment", r2(r.online.awaiting_total)],
  ];
  t.push({
    title: "Summary",
    columns: ["Measure", "Value"],
    money: [false, true],
    rows: summary,
  });

  if (till) {
    t.push({
      title: "Till cash-up",
      columns: ["Measure", "Rand"],
      money: [false, true],
      rows: [
        ["Tills closed", count(till.sessions_closed)],
        ["Opening floats", r2(till.opening_floats)],
        ["Cash taken from sales (after discounts)", r2(till.cash_sales)],
        ["Cash refunds paid out", r2(till.cash_refunds)],
        ["Till expenses paid in cash", r2(till.expenses)],
        ["Expected cash", r2(till.expected)],
        ["Counted cash", r2(till.counted)],
        ["Variance (counted - expected)", r2(till.variance)],
        ["Deposited to the bank", r2(till.deposited)],
        ["Float carried forward", r2(till.float_carried)],
        ["Variances awaiting approval", count(till.variances_pending)],
      ],
      note: "Expected cash = opening float + cash taken - cash refunds - till expenses. Discounts are already off the sales.",
    });
  }
  if (r.till_sessions?.length) {
    t.push({
      title: "Till sessions",
      columns: [
        "Drawer",
        "Cashier",
        "Closed",
        "Float",
        "Cash sales",
        "Refunds",
        "Expenses",
        "Discounts",
        "Expected",
        "Counted",
        "Variance",
        "Deposited",
        "Float left",
        "Approval",
        "Reason",
      ],
      money: [
        false,
        false,
        false,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        true,
        false,
        false,
      ],
      rows: r.till_sessions.map((s) => [
        s.drawer,
        s.cashier,
        sastShort(s.closed_at),
        r2(s.opening_float),
        r2(s.cash_sales),
        r2(s.cash_refunds),
        r2(s.expenses),
        r2(s.discounts),
        r2(s.expected),
        r2(s.counted),
        r2(s.variance),
        r2(s.deposited),
        r2(s.float_carried),
        s.approval.replace("_", " "),
        s.approval_note ?? "",
      ]),
    });
  }
  if (r.expenses?.length) {
    t.push({
      title: "Till expenses",
      columns: ["When", "Category", "Description", "By", "Amount"],
      money: [false, false, false, false, true],
      rows: r.expenses.map((e) => [sastShort(e.at), e.category, e.description, e.by, r2(e.amount)]),
    });
  }

  t.push({
    title: "Payment methods",
    columns: ["Channel", "Method", "Amount"],
    money: [false, false, true],
    rows: [
      ...Object.entries(r.pos_tenders).map(([k, v]) => ["Till", methodLabel(k), r2(v)] as Cell[]),
      ...Object.entries(r.online_methods).map(
        ([k, v]) => ["Online", methodLabel(k), r2(v)] as Cell[],
      ),
    ],
  });
  if (r.daily.length > 1)
    t.push({
      title: "Sales by day",
      columns: ["Day", "Till net", "Online", "Total"],
      money: [false, true, true, true],
      rows: r.daily.map((d) => [d.day, r2(d.pos), r2(d.online), r2(n(d.pos) + n(d.online))]),
    });
  t.push({
    title: "Top products",
    columns: ["Product", "Category", "Qty", "Till", "Online", "Revenue"],
    money: [false, false, false, true, true, true],
    rows: r.products.map((p) => [
      p.name,
      p.category ?? "",
      count(p.qty),
      r2(p.pos),
      r2(p.online),
      r2(p.revenue),
    ]),
  });
  t.push({
    title: "Categories",
    columns: ["Category", "Qty", "Revenue"],
    money: [false, false, true],
    rows: r.categories.map((c) => [c.category, count(c.qty), r2(c.revenue)]),
  });
  t.push({
    title: "Till sales by staff",
    columns: ["Staff member", "Sales", "Total"],
    money: [false, false, true],
    rows: r.cashiers.map((c) => [c.name, count(c.count), r2(c.total)]),
  });
  return t;
}

/** "R1 234.50"-style text for documents (PDF, Word). */
export const randText = (v: number) =>
  `${v < 0 ? "-" : ""}R${Math.abs(v).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
export const cellText = (c: Cell, money: boolean) =>
  typeof c === "object"
    ? String(c.count)
    : typeof c === "number" && money
      ? randText(c)
      : String(c);
/** The numeric value of a cell for spreadsheets (null for text). */
export const cellNumber = (c: Cell): number | null =>
  typeof c === "object" ? c.count : typeof c === "number" ? c : null;
