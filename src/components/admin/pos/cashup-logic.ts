/**
 * The till cash-up, as the database fixed it at close. Every figure comes from `pos_close_session`; this only
 * lays them out so the closing amount visibly reconciles:
 *   opening float + cash taken (after discounts) - cash refunds - till expenses = expected cash
 *   counted - expected = variance;  counted - bank deposit = float carried to the next session.
 */
export type CloseResult = {
  opening_float: number | string;
  cash_sales: number | string;
  cash_refunds: number | string;
  expenses_total: number | string;
  discounts_total: number | string;
  expected_cash: number | string;
  actual_cash: number | string;
  variance: number | string;
  cash_deposited: number | string;
  float_carried: number | string;
  approval_status: string;
  sales_count: number;
};

export type CashupLine = {
  label: string;
  amount: number;
  /** "+" adds to the drawer, "-" takes from it, "=" is a total, "i" is information only. */
  kind: "+" | "-" | "=" | "i";
  emphasis?: boolean;
};

const n = (v: number | string | null | undefined) => Number(v ?? 0);

export function cashupLines(r: CloseResult): CashupLine[] {
  return [
    { label: "Opening float", amount: n(r.opening_float), kind: "+" },
    { label: "Cash taken from sales (after discounts)", amount: n(r.cash_sales), kind: "+" },
    {
      label: "Discounts given (already off the sales)",
      amount: n(r.discounts_total),
      kind: "i",
    },
    { label: "Cash refunds paid out", amount: n(r.cash_refunds), kind: "-" },
    { label: "Till expenses paid in cash", amount: n(r.expenses_total), kind: "-" },
    { label: "Expected cash in drawer", amount: n(r.expected_cash), kind: "=", emphasis: true },
    { label: "Counted cash", amount: n(r.actual_cash), kind: "=" },
    { label: "Variance (counted - expected)", amount: n(r.variance), kind: "=", emphasis: true },
    { label: "Taken out for the bank deposit", amount: n(r.cash_deposited), kind: "-" },
    {
      label: "Float left for the next session",
      amount: n(r.float_carried),
      kind: "=",
      emphasis: true,
    },
  ];
}

/** True when the figures add up the way the database says they must (a guard for the display). */
export function reconciles(r: CloseResult): boolean {
  const cents = (v: number | string) => Math.round(n(v) * 100);
  return (
    cents(r.opening_float) +
      cents(r.cash_sales) -
      cents(r.cash_refunds) -
      cents(r.expenses_total) ===
      cents(r.expected_cash) &&
    cents(r.actual_cash) - cents(r.expected_cash) === cents(r.variance) &&
    cents(r.actual_cash) - cents(r.cash_deposited) === cents(r.float_carried)
  );
}

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  supplies: "Supplies",
  cleaning: "Cleaning",
  transport: "Transport",
  food: "Food / refreshments",
  maintenance: "Maintenance",
  stock: "Stock purchase",
  other: "Other",
};
