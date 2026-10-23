import { describe, expect, it } from "vitest";
import {
  buildReceiptModel,
  firstName,
  maskReference,
  receiptText,
  vatIncluded,
  type ReceiptSettings,
} from "@/lib/receipts/receipt-model";
import { renderReceiptPdf } from "@/lib/receipts/receipt-pdf";

const settings: ReceiptSettings = {
  trading_name: "CannaPlug",
  legal_name: "CANNAPLUG PTY LTD",
  registration_number: "2026/047873/07",
  licence_lines: ["Licensed medical cannabis dispensary", "SAHPRA Section 21 authorised"],
  address: "Shop 002, One On Mutual, Pretoria Central",
  phone: "+27 68 291 2107",
  email: "info@cannaplug012.co.za",
  vat_registered: false,
  vat_number: null,
  vat_rate: 15,
  footer_message: "Thank you.",
  returns_policy: "Keep this receipt.",
  default_paper: "80mm",
};
const input = {
  sale: {
    receipt_number: "POS-261023-000007",
    created_at: "2026-10-23T13:12:00Z",
    status: "completed",
    subtotal: 290,
    total: 290,
  },
  items: [
    {
      product_name: "White Runtz (Top Shelf)",
      quantity: 2,
      unit_price_rand: 120,
      line_total: 240,
      unit: "g",
    },
    { product_name: "King’s Cherry – 1g", quantity: 1, unit_price_rand: 50, line_total: 50 },
  ],
  tenders: [
    { method: "cash", amount: 190, reference: null },
    { method: "card", amount: 100, reference: "AUTH-998877" },
  ],
  settings,
  cashierName: "Thabo Mokoena",
  customerName: "Lerato Dlamini",
  cashReceived: 200,
  loyaltyPoints: 29,
};

describe("receipt model", () => {
  it("shows first names only, masks card references and works out change on the cash part", () => {
    const m = buildReceiptModel(input);
    expect(m.cashier).toBe("Thabo");
    expect(m.customer).toBe("Lerato");
    expect(m.tenders.map((t) => t.label)).toEqual(["Cash", "Card …8877"]);
    expect(m.change).toBe(10);
    expect(m.issuedAtLocal).toMatch(/23 Oct 2026/);
    expect(m.issuedAtLocal).toMatch(/15:12/); // SAST
  });
  it("adds VAT only when the business is VAT-registered", () => {
    expect(buildReceiptModel(input).vat).toBeNull();
    const m = buildReceiptModel({
      ...input,
      settings: { ...settings, vat_registered: true, vat_number: "4123456789" },
    });
    expect(m.vat).toEqual({ rate: 15, amount: 37.83, number: "4123456789" });
    expect(vatIncluded(115, 15)).toBe(15);
  });
  it("never shows change when cash received is less than the cash due", () => {
    expect(buildReceiptModel({ ...input, cashReceived: 150 }).change).toBeNull();
    expect(buildReceiptModel({ ...input, cashReceived: null }).change).toBeNull();
  });
  it("helpers", () => {
    expect(maskReference("12")).toBe("12");
    expect(maskReference(null)).toBeNull();
    expect(firstName("  ")).toBe("Staff");
  });
  it("plain-text version carries the business details and totals", () => {
    const t = receiptText(buildReceiptModel(input));
    expect(t).toContain("CANNAPLUG PTY LTD");
    expect(t).toContain("SAHPRA Section 21 authorised");
    expect(t).toContain("POS-261023-000007");
    expect(t).toMatch(/Total R290[,.]00/);
  });
});

describe("receipt PDF", () => {
  for (const paper of ["80mm", "58mm", "a4"] as const) {
    it(`renders a valid ${paper} PDF, including characters outside WinAnsi`, async () => {
      const bytes = await renderReceiptPdf(buildReceiptModel(input), paper);
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(5000);
    });
  }
});
