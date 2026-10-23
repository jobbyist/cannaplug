// POS receipt: the view model shared by the print page, the PDF and the email. Built only from stored records.
// Never include ID, health or clinical data on a receipt.

export type PaperSize = "80mm" | "58mm" | "a4";
export const PAPER_SIZES: PaperSize[] = ["80mm", "58mm", "a4"];

export type ReceiptSettings = {
  trading_name: string;
  legal_name: string;
  registration_number: string | null;
  licence_lines: string[];
  address: string;
  phone: string | null;
  email: string | null;
  vat_registered: boolean;
  vat_number: string | null;
  vat_rate: number;
  footer_message: string | null;
  returns_policy: string | null;
  default_paper: PaperSize;
};

export type ReceiptLine = {
  name: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  total: number;
};
export type ReceiptTender = { method: string; amount: number; reference: string | null };

export type ReceiptModel = {
  kind: "sale" | "refund";
  receiptNumber: string;
  issuedAt: string; // ISO
  issuedAtLocal: string; // "23 Oct 2026, 15:04" SAST
  cashier: string;
  customer: string | null;
  status: string;
  lines: ReceiptLine[];
  subtotal: number;
  total: number;
  vat: { rate: number; amount: number; number: string } | null;
  tenders: { label: string; amount: number }[];
  cashReceived: number | null;
  change: number | null;
  loyaltyPoints: number | null;
  business: ReceiptSettings;
};

const TENDER_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  eft: "EFT",
  paypal: "PayPal",
};

/** Card and EFT references: only the last 4 characters are printed. */
export function maskReference(ref: string | null): string | null {
  if (!ref) return null;
  const t = ref.trim();
  return t.length <= 4 ? t : `…${t.slice(-4)}`;
}

export const roundCents = (n: number) => Math.round(n * 100) / 100;

/** VAT included in a VAT-inclusive total: total × rate / (100 + rate), to the cent. */
export function vatIncluded(total: number, rate: number): number {
  return roundCents((total * rate) / (100 + rate));
}

export function formatSast(iso: string): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export const formatRand = (n: number) =>
  `R${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u00a0/g, " ")}`;

/** First name only: receipts identify the cashier without exposing their full name. */
export const firstName = (full: string | null | undefined) =>
  (full ?? "").trim().split(/\s+/)[0] || "Staff";

export function buildReceiptModel(input: {
  sale: {
    receipt_number: string;
    created_at: string;
    status: string;
    subtotal: number;
    total: number;
  };
  items: {
    product_name: string;
    quantity: number;
    unit_price_rand: number;
    line_total: number;
    unit?: string | null;
  }[];
  tenders: { method: string; amount: number; reference: string | null }[];
  settings: ReceiptSettings;
  cashierName: string | null;
  customerName: string | null;
  cashReceived: number | null;
  loyaltyPoints: number | null;
}): ReceiptModel {
  const { sale, settings } = input;
  const total = roundCents(Number(sale.total));
  const cashPaid = roundCents(
    input.tenders.filter((t) => t.method === "cash").reduce((s, t) => s + Number(t.amount), 0),
  );
  const cashReceived = input.cashReceived != null ? roundCents(Number(input.cashReceived)) : null;
  return {
    kind: "sale",
    receiptNumber: sale.receipt_number,
    issuedAt: sale.created_at,
    issuedAtLocal: formatSast(sale.created_at),
    cashier: firstName(input.cashierName),
    customer: input.customerName ? firstName(input.customerName) : null,
    status: sale.status,
    lines: input.items.map((i) => ({
      name: i.product_name,
      quantity: i.quantity,
      unit: i.unit ?? null,
      unitPrice: roundCents(Number(i.unit_price_rand)),
      total: roundCents(Number(i.line_total)),
    })),
    subtotal: roundCents(Number(sale.subtotal)),
    total,
    vat:
      settings.vat_registered && settings.vat_number
        ? {
            rate: Number(settings.vat_rate),
            amount: vatIncluded(total, Number(settings.vat_rate)),
            number: settings.vat_number,
          }
        : null,
    tenders: input.tenders.map((t) => {
      const ref = maskReference(t.reference);
      return {
        label: `${TENDER_LABEL[t.method] ?? t.method}${ref ? ` ${ref}` : ""}`,
        amount: roundCents(Number(t.amount)),
      };
    }),
    cashReceived: cashReceived && cashReceived >= cashPaid && cashPaid > 0 ? cashReceived : null,
    change:
      cashReceived && cashPaid > 0 && cashReceived >= cashPaid
        ? roundCents(cashReceived - cashPaid)
        : null,
    loyaltyPoints: input.loyaltyPoints,
    business: settings,
  };
}

/** Plain-text receipt for the email body (the PDF carries the branded version). */
export function receiptText(m: ReceiptModel): string {
  const b = m.business;
  const out = [
    b.legal_name,
    ...b.licence_lines,
    b.address,
    [b.phone, b.email].filter(Boolean).join(" · "),
    b.registration_number ? `Reg: ${b.registration_number}` : "",
    "",
    `Receipt ${m.receiptNumber}`,
    `${m.issuedAtLocal} · Served by ${m.cashier}`,
    "",
    ...m.lines.map(
      (l) =>
        `${l.quantity}${l.unit ? ` ${l.unit}` : ""} × ${l.name} @ ${formatRand(l.unitPrice)} = ${formatRand(l.total)}`,
    ),
    "",
    `Total ${formatRand(m.total)}`,
    ...(m.vat
      ? [`Includes VAT (${m.vat.rate}%) ${formatRand(m.vat.amount)} · VAT no. ${m.vat.number}`]
      : []),
    ...m.tenders.map((t) => `${t.label} ${formatRand(t.amount)}`),
    ...(m.change != null ? [`Change ${formatRand(m.change)}`] : []),
    ...(m.loyaltyPoints ? [`Loyalty points earned: ${m.loyaltyPoints}`] : []),
    "",
    b.footer_message ?? "",
    b.returns_policy ?? "",
  ];
  return out
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}
