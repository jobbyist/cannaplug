import { isPayoutType, type HistoryRow } from "./payfast-api";

/**
 * The PayFast account as the admin panel shows it, worked out from PayFast's own Transaction History.
 *
 * Payout schedule: set by the owner in PayFast (Payouts → automated payout): daily, once the balance is at least
 * R100. PayFast charges a payout fee of R8.70 excl. VAT per payout (payfast.io/fees, 27 Oct 2026). PayFast does not
 * publish the bank clearing time, so the panel says when PayFast sent a payout, not when the bank shows it.
 */
export const PAYOUT_SCHEDULE = {
  frequency: "daily" as const,
  thresholdRand: 100,
  payoutFeeExVat: 8.7,
  vatRate: 0.15,
};

export const FUNDING_LABEL: Record<string, string> = {
  CC: "Card",
  DC: "Debit card",
  EFT: "Instant EFT",
  IEFT: "Instant EFT",
  MP: "Masterpass",
  AP: "Apple Pay",
  GP: "Google Pay",
};
export const fundingLabel = (code: string) =>
  FUNDING_LABEL[code.toUpperCase()] ?? (code || "Other");

export type PayoutView = { date: string; amount: number; fee: number; status: "completed" };
export type NextPayout =
  | { status: "pending"; amount: number; when: "today" | "next daily run"; feeExVat: number }
  | { status: "below_threshold"; short: number; threshold: number };

export type PayfastAccountSummary = {
  balance: number;
  balanceAsAt: string | null;
  today: { day: string; gross: number; fees: number; net: number; count: number };
  period: {
    from: string;
    gross: number;
    fees: number;
    net: number;
    count: number;
    byMethod: { method: string; gross: number; fees: number; count: number }[];
    refunds: number;
    payoutFees: number;
  };
  payouts: PayoutView[];
  next: NextPayout;
  recent: {
    date: string;
    kind: "payment" | "payout" | "refund" | "fee" | "other";
    method: string;
    gross: number;
    fee: number;
    net: number;
    balance: number;
    transactionId: string;
  }[];
};

const r2 = (v: number) => Math.round(v * 100) / 100;

const kindOf = (r: HistoryRow): PayfastAccountSummary["recent"][number]["kind"] =>
  isPayoutType(r.type, r.description)
    ? "payout"
    : r.type === "FUNDS_RECEIVED" && r.sign === "CREDIT"
      ? "payment"
      : /refund/i.test(r.type) || /refund/i.test(r.description)
        ? "refund"
        : /fee|charge/i.test(r.type)
          ? "fee"
          : "other";

/** `today` is the South African calendar day (YYYY-MM-DD); `from` the first day of the period fetched. */
export function summariseAccount(
  rows: HistoryRow[],
  today: string,
  from: string,
): PayfastAccountSummary {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted.at(-1) ?? null;
  const balance = r2(last?.balance ?? 0);
  const payments = sorted.filter((r) => kindOf(r) === "payment");
  const todays = payments.filter((r) => r.date.startsWith(today));
  const methods = new Map<string, { gross: number; fees: number; count: number }>();
  for (const p of payments) {
    const k = fundingLabel(p.fundingType);
    const m = methods.get(k) ?? { gross: 0, fees: 0, count: 0 };
    m.gross += p.gross;
    m.fees += Math.abs(p.fee);
    m.count += 1;
    methods.set(k, m);
  }
  const payouts: PayoutView[] = sorted
    .filter((r) => kindOf(r) === "payout")
    .map((r) => ({
      date: r.date,
      amount: r2(Math.abs(r.gross || r.net)),
      fee: r2(Math.abs(r.fee)),
      status: "completed" as const,
    }))
    .reverse();
  const paidOutToday = payouts.some((p) => p.date.startsWith(today));
  const next: NextPayout =
    balance >= PAYOUT_SCHEDULE.thresholdRand
      ? {
          status: "pending",
          amount: balance,
          when: paidOutToday ? "next daily run" : "today",
          feeExVat: PAYOUT_SCHEDULE.payoutFeeExVat,
        }
      : {
          status: "below_threshold",
          short: r2(PAYOUT_SCHEDULE.thresholdRand - balance),
          threshold: PAYOUT_SCHEDULE.thresholdRand,
        };
  const sum = (xs: HistoryRow[], f: (r: HistoryRow) => number) =>
    r2(xs.reduce((t, r) => t + f(r), 0));
  return {
    balance,
    balanceAsAt: last?.date ?? null,
    today: {
      day: today,
      gross: sum(todays, (r) => r.gross),
      fees: sum(todays, (r) => Math.abs(r.fee)),
      net: sum(todays, (r) => r.net),
      count: todays.length,
    },
    period: {
      from,
      gross: sum(payments, (r) => r.gross),
      fees: sum(payments, (r) => Math.abs(r.fee)),
      net: sum(payments, (r) => r.net),
      count: payments.length,
      byMethod: [...methods.entries()]
        .map(([method, m]) => ({ method, gross: r2(m.gross), fees: r2(m.fees), count: m.count }))
        .sort((a, b) => b.gross - a.gross),
      refunds: sum(
        sorted.filter((r) => kindOf(r) === "refund"),
        (r) => Math.abs(r.net),
      ),
      payoutFees: sum(
        sorted.filter((r) => kindOf(r) === "payout"),
        (r) => Math.abs(r.fee),
      ),
    },
    payouts: payouts.slice(0, 20),
    next,
    recent: sorted
      .slice(-15)
      .reverse()
      .map((r) => ({
        date: r.date,
        kind: kindOf(r),
        method: fundingLabel(r.fundingType),
        gross: r2(r.gross),
        fee: r2(Math.abs(r.fee)),
        net: r2(r.net),
        balance: r2(r.balance),
        transactionId: r.mPaymentId,
      })),
  };
}

/**
 * PayFast's published fees (payfast.io/fees, checked 27 Oct 2026). All excl. VAT (15%). Shown in the admin fees
 * dialog; the live "fees charged" figures come from the Transaction History, not from this table.
 */
export const PAYFAST_FEES = {
  source: "https://payfast.io/fees/",
  checked: "27 Oct 2026",
  methods: [
    { method: "Credit and debit card", fee: "3.2% + R2.00", example: 18 },
    { method: "Instant EFT", fee: "2.0% (minimum R2.00)", example: 12 },
    { method: "Apple Pay", fee: "3.2% + R2.00", example: 18 },
    { method: "Google Pay", fee: "3.2% + R2.00", example: 18 },
  ],
  other: [
    { item: "Refund", fee: "R2.00 per refund" },
    { item: "Payout to your bank (incl. automated daily payout)", fee: "R8.70 per payout" },
    { item: "Immediate payout", fee: "0.8% (minimum R14.00)" },
  ],
  notes: [
    "Fees exclude VAT; PayFast adds 15% VAT.",
    "Examples are on a R500.00 payment, excl. VAT.",
    "Masterpass (offered only in PayFast's onsite window) is not listed on PayFast's fees page: check your PayFast statement.",
    "Chargeback and monthly fees are not listed on PayFast's fees page.",
  ],
};
