// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: { channel: () => channel, removeChannel: async () => {} } };
});

import { StaffBadge } from "@/components/StaffBadge";
import { SalesFeed } from "@/components/admin/reports/LiveSales";
import { OrderTable } from "@/components/admin/orders/OrdersPanel";
import { cartSummary, STAFF_PERCENT, type CartLine } from "@/components/admin/pos/pos-logic";
import { simulateSale } from "@/components/admin/pos/demo-logic";
import { reportTables } from "@/lib/sales-report-export";
import { salesReportCsv, type SalesReport } from "@/lib/sales-report-logic";
import { buildReceiptModel, receiptText } from "@/lib/receipts/receipt-model";

afterEach(() => cleanup());

const line = (price: number, quantity: number, discount?: CartLine["discount"]): CartLine => ({
  product: {
    id: `p${price}`,
    slug: "p",
    name: "Item",
    category: "Flower",
    subcategory: null,
    strain_type: null,
    unit: null,
    price_rand: price,
    available: 99,
  },
  quantity,
  ...(discount ? { discount } : {}),
});

describe("staff rate in the till total (display only; the database is the authority)", () => {
  it("is 20% off the goods for a staff customer, and nothing for anyone else", () => {
    expect(STAFF_PERCENT).toBe(20);
    const staff = cartSummary([line(100, 2)], undefined, true);
    expect(staff.staffDiscountCents).toBe(4000);
    expect(staff.totalCents).toBe(16000);
    expect(staff.hasDiscount).toBe(true);
    expect(staff.hasManualDiscount).toBe(false); // no reason is needed for the staff rate alone
    const member = cartSummary([line(100, 2)], undefined, false);
    expect(member.totalCents).toBe(20000);
    expect(member.staffDiscountCents).toBe(0);
  });

  it("comes off after line discounts and is not added to a typed order discount (the larger applies)", () => {
    // 10% line discount: 200 -> 180; staff 20% of 180 = 36 -> 144
    const afterLine = cartSummary(
      [line(100, 2, { kind: "percent", value: "10" })],
      undefined,
      true,
    );
    expect(afterLine.totalCents).toBe(14400);
    expect(afterLine.hasManualDiscount).toBe(true);
    // typed 10% (20) < staff (40): staff applies
    expect(cartSummary([line(100, 2)], { kind: "percent", value: "10" }, true).totalCents).toBe(
      16000,
    );
    // typed 30% (60) > staff (40): the typed discount applies, and needs a reason
    const big = cartSummary([line(100, 2)], { kind: "percent", value: "30" }, true);
    expect(big.totalCents).toBe(14000);
    expect(big.hasManualDiscount).toBe(true);
  });

  it("rounds to the cent like the database", () => {
    expect(cartSummary([line(0.55, 1)], undefined, true).totalCents).toBe(44); // 55 - round(11) = 44
    expect(cartSummary([line(1.25, 1)], undefined, true).totalCents).toBe(100); // 125 - 25
    expect(cartSummary([line(9.99, 1)], undefined, true).totalCents).toBe(799); // 999 - round(199.8)=200
  });
});

describe("the Demo till applies the staff rate too", () => {
  it("a staff practice sale is 20% off and flagged; a normal one is not", () => {
    const base = {
      lines: [line(100, 2)],
      orderDiscount: undefined,
      tenders: [{ rowId: "r", method: "cash" as const, amount: "160.00", reference: "" }],
      receiptNumber: "DEMO-0001",
      cashReceived: "",
    };
    const staff = simulateSale({ ...base, staff: true });
    expect(staff.sale.total).toBe(160);
    expect(staff.sale.staff_purchase).toBe(true);
    expect(staff.sale.items[0]!.line_total).toBe(160);
    expect(
      simulateSale({ ...base, tenders: [{ ...base.tenders[0]!, amount: "200.00" }] }).sale,
    ).toMatchObject({
      total: 200,
      staff_purchase: false,
    });
  });
});

describe("the Staff badge", () => {
  it("shows next to a staff purchase in the orders list and not next to others", () => {
    const orders = [
      {
        id: "1",
        order_number: "CP-1",
        customer_name: "Staff Person",
        total_rand: 80,
        status: "completed",
        created_at: "2026-10-28T08:00:00Z",
        staff_purchase: true,
      },
      {
        id: "2",
        order_number: "CP-2",
        customer_name: "Member",
        total_rand: 100,
        status: "completed",
        created_at: "2026-10-28T08:00:00Z",
        staff_purchase: false,
      },
    ] as never;
    render(<OrderTable orders={orders} onSelect={() => {}} />);
    const rows = screen.getAllByRole("row");
    expect(
      within(rows.find((r) => r.textContent?.includes("CP-1"))!).queryByTestId("staff-badge"),
    ).toBeTruthy();
    expect(
      within(rows.find((r) => r.textContent?.includes("CP-2"))!).queryByTestId("staff-badge"),
    ).toBeNull();
  });

  const report = (staff: SalesReport["staff"]): SalesReport =>
    ({
      from: "2026-10-28",
      to: "2026-10-28",
      generated_at: "2026-10-28T10:00:00Z",
      total: 180,
      transactions: 2,
      average_sale: 90,
      pos: {
        count: 2,
        gross: 180,
        refunds: 0,
        refund_count: 0,
        voided_count: 0,
        voided_total: 0,
        net: 180,
      },
      online: {
        count: 0,
        total: 0,
        delivery_fees: 0,
        awaiting_count: 0,
        awaiting_total: 0,
        cancelled_count: 0,
        pickup_count: 0,
      },
      daily: [],
      hourly: [],
      pos_tenders: { cash: 180 },
      online_methods: {},
      products: [],
      categories: [],
      cashiers: [],
      recent: [
        {
          channel: "pos",
          ref: "POS-S",
          amount: 80,
          status: "completed",
          at: "2026-10-28T09:30:00Z",
          method: "cash",
          staff: true,
        },
        {
          channel: "pos",
          ref: "POS-N",
          amount: 100,
          status: "completed",
          at: "2026-10-28T09:00:00Z",
          method: "cash",
          staff: false,
        },
      ],
      ...(staff ? { staff } : {}),
    }) as SalesReport;
  const staffSection = {
    percent: 20,
    count: 1,
    total: 80,
    discount: 20,
    pos: { count: 1, total: 80, discount: 20 },
    online: { count: 0, total: 0, discount: 0 },
  };

  it("flags staff transactions in the latest-sales feed", () => {
    render(<SalesFeed report={report(staffSection)} />);
    const items = screen.getAllByRole("listitem");
    expect(
      within(items.find((i) => i.textContent?.includes("POS-S"))!).queryByTestId("staff-badge"),
    ).toBeTruthy();
    expect(
      within(items.find((i) => i.textContent?.includes("POS-N"))!).queryByTestId("staff-badge"),
    ).toBeNull();
  });

  it("reports and exports carry a Staff purchases section", () => {
    const tables = reportTables(report(staffSection));
    const t = tables.find((x) => x.title.startsWith("Staff purchases"))!;
    expect(t.title).toContain("20% staff rate");
    expect(t.rows.at(-1)).toEqual(["Total", expect.anything(), 80, 20]);
    expect(salesReportCsv(report(staffSection))).toMatch(
      /Staff purchases,Count,Paid,Staff discount/,
    );
    // an older report (no staff data) is unchanged
    expect(reportTables(report(undefined)).some((x) => x.title.startsWith("Staff purchases"))).toBe(
      false,
    );
  });

  it("renders on its own", () => {
    render(<StaffBadge />);
    expect(screen.getByTestId("staff-badge").textContent).toBe("Staff");
  });
});

describe("receipts", () => {
  const settings = {
    trading_name: "CannaPlug",
    legal_name: "CANNAPLUG PTY LTD",
    registration_number: null,
    licence_lines: [],
    address: "Pretoria",
    phone: null,
    email: null,
    vat_registered: false,
    vat_number: null,
    vat_rate: 15,
    footer_message: null,
    returns_policy: null,
    default_paper: "80mm" as const,
  };
  const build = (staff: boolean) =>
    buildReceiptModel({
      sale: {
        receipt_number: "POS-1",
        created_at: "2026-10-28T10:00:00Z",
        status: "completed",
        subtotal: 100,
        discount_rand: staff ? 20 : 0,
        staff_purchase: staff,
        total: staff ? 80 : 100,
      },
      items: [
        {
          product_name: "Item",
          quantity: 1,
          unit_price_rand: 100,
          line_discount_rand: 0,
          order_discount_rand: staff ? 20 : 0,
          line_total: staff ? 80 : 100,
        },
      ],
      tenders: [{ method: "cash", amount: staff ? 80 : 100, reference: null }],
      settings,
      cashierName: "Thabo",
      customerName: null,
      cashReceived: null,
      loyaltyPoints: null,
    });
  it("say when the staff rate was applied, and nothing otherwise", () => {
    expect(receiptText(build(true))).toContain("Staff purchase (staff rate applied)");
    expect(receiptText(build(true))).toContain("Discount -R20,00");
    expect(receiptText(build(false))).not.toContain("Staff purchase");
  });
});
