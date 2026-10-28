// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDemoSale,
  demoReceiptNumber,
  simulateClose,
  simulateSale,
  takeDemoStock,
} from "@/components/admin/pos/demo-logic";
import { reconciles } from "@/components/admin/pos/cashup-logic";
import { canSee } from "@/lib/admin-nav";
import type { CartLine, CatalogItem } from "@/components/admin/pos/pos-logic";

const item = (id: string, name: string, price: number, available = 5): CatalogItem => ({
  id,
  slug: id,
  name,
  category: "Flower",
  subcategory: null,
  strain_type: null,
  unit: null,
  price_rand: price,
  available,
});

const server = vi.hoisted(() => ({
  getDemoTillCatalogFn: vi.fn(),
  // Every function that writes. A demo must never call any of them.
  completePosSaleFn: vi.fn(),
  openPosSessionFn: vi.fn(),
  closePosSessionFn: vi.fn(),
  addPosExpenseFn: vi.fn(),
  voidPosExpenseFn: vi.fn(),
  reviewPosSessionFn: vi.fn(),
  refundPosSaleFn: vi.fn(),
  voidPosSaleFn: vi.fn(),
  upsertDrawerFn: vi.fn(),
  receiveStockFn: vi.fn(),
  adjustStockFn: vi.fn(),
  findPosSaleFn: vi.fn(),
  getPosOverviewFn: vi.fn(),
  listBatchesFn: vi.fn(),
}));
const other = vi.hoisted(() => ({
  listCustomersFn: vi.fn(),
  setProductSaleFn: vi.fn(),
  recordCashReceivedFn: vi.fn(),
}));
vi.mock("@/lib/pos.functions", () => server);
vi.mock("@/lib/admin.functions", () => ({
  listCustomersFn: other.listCustomersFn,
  setProductSaleFn: other.setProductSaleFn,
}));
vi.mock("@/lib/receipts.functions", () => ({ recordCashReceivedFn: other.recordCashReceivedFn }));

import { DemoTill } from "@/components/admin/pos/DemoTill";

const catalog = [item("p1", "Blue Gelato", 50, 5), item("p2", "Sour OG", 70, 2)];

beforeEach(() => {
  [...Object.values(server), ...Object.values(other)].forEach((f) => f.mockReset());
  server.getDemoTillCatalogFn.mockResolvedValue({ catalog });
});
afterEach(() => cleanup());

describe("demo till maths", () => {
  const lines: CartLine[] = [
    { product: catalog[0]!, quantity: 2 },
    { product: catalog[1]!, quantity: 1, discount: { kind: "percent", value: "10" } },
  ];
  it("works out a practice receipt that adds up to the cent", () => {
    const r = simulateSale({
      lines,
      orderDiscount: { kind: "amount", value: "10" },
      tenders: [{ rowId: "r", method: "cash", amount: "153.00", reference: "" }],
      receiptNumber: demoReceiptNumber(1),
      cashReceived: "200",
    });
    expect(r.sale.receipt_number).toBe("DEMO-0001");
    expect(r.sale.total).toBe(153);
    expect(r.sale.items.reduce((s, i) => s + Math.round(i.line_total * 100), 0)).toBe(15300);
    expect(r.cashReceivedCents).toBe(20000);
  });
  it("a free (100%) practice sale totals R0", () => {
    const r = simulateSale({
      lines,
      orderDiscount: { kind: "percent", value: "100" },
      tenders: [],
      receiptNumber: "DEMO-0002",
      cashReceived: "",
    });
    expect(r.sale.total).toBe(0);
    expect(r.sale.items.every((i) => i.line_total === 0)).toBe(true);
  });
  it("a practice cash-up reconciles exactly like the database's (expected, variance, float left)", () => {
    const r = simulateClose({
      openingFloat: 500,
      cashSalesCents: 30000,
      expenses: [
        {
          id: "a",
          amount: 45.5,
          category: "supplies",
          description: "x",
          created_at: "",
          mine: true,
        },
        {
          id: "b",
          amount: 120,
          category: "transport",
          description: "y",
          created_at: "",
          mine: true,
        },
      ],
      discountsCents: 0,
      salesCount: 2,
      actualCash: "634.50",
      cashDeposited: "400",
    });
    expect(r).toMatchObject({
      expected_cash: "634.50",
      variance: "0.00",
      float_carried: "234.50",
      approval_status: "not_required",
    });
    expect(reconciles(r)).toBe(true);
    expect(
      simulateClose({
        ...{ openingFloat: 100, cashSalesCents: 0, expenses: [], discountsCents: 0, salesCount: 0 },
        actualCash: "90.00",
        cashDeposited: "0",
      }).approval_status,
    ).toBe("not_required");
    expect(
      simulateClose({
        ...{ openingFloat: 100, cashSalesCents: 0, expenses: [], discountsCents: 0, salesCount: 0 },
        actualCash: "89.99",
        cashDeposited: "0",
      }).approval_status,
    ).toBe("pending");
  });

  it("takes stock off the demo copy only, and a demo sale price changes the copy only", () => {
    const next = takeDemoStock(catalog, lines);
    expect(next.map((p) => p.available)).toEqual([3, 1]);
    expect(catalog.map((p) => p.available)).toEqual([5, 2]); // the source is untouched
    const sale = applyDemoSale(catalog, { productId: "p1", salePrice: 40 });
    expect(sale[0]).toMatchObject({ price_rand: 40, regular_price_rand: 50 });
    expect(applyDemoSale(sale, { productId: "p1", salePrice: null })[0]).toMatchObject({
      price_rand: 50,
      regular_price_rand: null,
    });
  });
});

describe("demo till screen", () => {
  const openTill = async (user: ReturnType<typeof userEvent.setup>, float = "500") => {
    await user.selectOptions(await screen.findByLabelText("Drawer"), "demo-drawer");
    const f = screen.getByLabelText("Opening float (R)");
    await user.clear(f);
    await user.type(f, float);
    await user.click(screen.getByRole("button", { name: "Open till" }));
  };
  const sellOne = async () => {
    const user = userEvent.setup();
    render(<DemoTill />);
    await openTill(user);
    const search = await screen.findByLabelText("Search products");
    await user.type(search, "gelato{Enter}");
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(screen.getByRole("button", { name: /Complet(e|ing)/ }));
    return user;
  };

  it("says it is a test, and completes a practice sale with a DEMO receipt and no save, print or email", async () => {
    await sellOne();
    expect(screen.getByTestId("demo-till-banner").textContent).toMatch(/Test transactions only/);
    expect(await screen.findByText("DEMO-0001")).toBeTruthy();
    expect(screen.getByText("Demo sale complete")).toBeTruthy();
    expect(screen.getByText(/Practice receipt only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /print|email/i })).toBeNull();
    expect(screen.getByText(/1 practice sale/)).toBeTruthy();
  });

  it("calls no function that writes (no sale, stock, session, receipt or sale-price change)", async () => {
    await sellOne();
    await screen.findByText("DEMO-0001");
    const writers = [
      server.completePosSaleFn,
      server.openPosSessionFn,
      server.closePosSessionFn,
      server.refundPosSaleFn,
      server.voidPosSaleFn,
      server.addPosExpenseFn,
      server.voidPosExpenseFn,
      server.upsertDrawerFn,
      server.receiveStockFn,
      server.adjustStockFn,
      other.setProductSaleFn,
      other.recordCashReceivedFn,
    ];
    for (const w of writers) expect(w).not.toHaveBeenCalled();
    expect(server.getDemoTillCatalogFn).toHaveBeenCalledTimes(1);
  });

  it("uses up the demo stock, and Reset brings it back and restarts the receipt numbers", async () => {
    const user = userEvent.setup();
    render(<DemoTill />);
    await openTill(user);
    const search = await screen.findByLabelText("Search products");
    await user.type(search, "sour{Enter}");
    await user.clear(screen.getByLabelText("Quantity for Sour OG"));
    await user.type(screen.getByLabelText("Quantity for Sour OG"), "2");
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(screen.getByRole("button", { name: /Complet(e|ing)/ }));
    await screen.findByText("DEMO-0001");
    await user.type(await screen.findByLabelText("Search products"), "sour{Enter}");
    expect(screen.queryByLabelText("Quantity for Sour OG")).toBeNull(); // out of demo stock
    await user.click(screen.getByRole("button", { name: /Reset demo/ }));
    await waitFor(() => expect(screen.queryByText(/practice sale/)).toBeNull());
    await openTill(user);
    await user.clear(screen.getByLabelText("Search products"));
    await user.type(screen.getByLabelText("Search products"), "sour{Enter}");
    expect(await screen.findByLabelText("Quantity for Sour OG")).toBeTruthy();
    expect(server.getDemoTillCatalogFn).toHaveBeenCalledTimes(1); // reset does not even re-read
  });
});

describe("demo till: open, expenses, bank deposit and cash-up", () => {
  const typeInto = async (
    user: ReturnType<typeof userEvent.setup>,
    label: string | RegExp,
    value: string,
  ) => {
    const el = screen.getByLabelText(label);
    await user.clear(el);
    await user.type(el, value);
  };

  it("opens a practice till, records an expense, takes a cash sale, and shows the cash-up with the deposit", async () => {
    const user = userEvent.setup();
    render(<DemoTill />);
    // Open with a R500 float.
    await user.selectOptions(await screen.findByLabelText("Drawer"), "demo-drawer");
    await typeInto(user, "Opening float (R)", "500");
    await user.click(screen.getByRole("button", { name: "Open till" }));
    expect(await screen.findByText(/Demo till open/)).toBeTruthy();
    // A R50 cash sale.
    await user.type(await screen.findByLabelText("Search products"), "gelato{Enter}");
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(screen.getByRole("button", { name: /Complet(e|ing)/ }));
    await screen.findByText("DEMO-0001");
    // A R45.50 expense paid from the till.
    const expenses = screen.getByTestId("till-expenses");
    await typeInto(user, "Amount (R)", "45.50");
    await user.type(within(expenses).getByLabelText("What for"), "Cleaning materials");
    await user.click(within(expenses).getByRole("button", { name: /Add/ }));
    expect(await within(expenses).findByText("Cleaning materials", { exact: false })).toBeTruthy();
    expect(within(expenses).getByText("Total paid out").nextSibling?.textContent).toBe("R45,50");
    // Close: expected = 500 + 50 - 45.50 = 504.50. Count 504.50, bank R400.
    await typeInto(user, "Counted cash (R)", "504.50");
    await typeInto(user, /Cash for bank deposit/, "400");
    expect(screen.getByText(/Float left in the drawer for the next session: R104,50/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close till" }));
    const closed = await screen.findByTestId("till-closed");
    const text = closed.textContent ?? "";
    expect(text).toMatch(/Opening float.*R500,00/);
    expect(text).toMatch(/Cash taken from sales \(after discounts\)R50,00Discounts/);
    expect(text).toMatch(/Till expenses paid in cash.*R45,50/);
    expect(text).toMatch(/Expected cash in drawer.*R504,50/);
    expect(text).toMatch(/Variance.*R0,00/);
    expect(text).toMatch(/Taken out for the bank deposit.*R400,00/);
    expect(text).toMatch(/Float left for the next session.*R104,50/);
    expect(text).toMatch(/Within tolerance/);
    // Done: back to Open till, suggesting the float left in the drawer.
    await user.click(within(closed).getByRole("button", { name: "Done" }));
    await user.selectOptions(await screen.findByLabelText("Drawer"), "demo-drawer");
    expect((screen.getByLabelText("Opening float (R)") as HTMLInputElement).value).toBe("104.50");
    // None of it touched the server.
    for (const w of [
      server.openPosSessionFn,
      server.closePosSessionFn,
      server.addPosExpenseFn,
      server.voidPosExpenseFn,
      server.completePosSaleFn,
    ])
      expect(w).not.toHaveBeenCalled();
  });

  it("a count more than R10 out needs a manager's approval, as at the real till", async () => {
    const user = userEvent.setup();
    render(<DemoTill />);
    await user.selectOptions(await screen.findByLabelText("Drawer"), "demo-drawer");
    await typeInto(user, "Opening float (R)", "100");
    await user.click(screen.getByRole("button", { name: "Open till" }));
    await typeInto(user, "Counted cash (R)", "80");
    await user.click(screen.getByRole("button", { name: "Close till" }));
    const closed = await screen.findByTestId("till-closed");
    expect(closed.textContent).toMatch(/Variance.*R-20,00/);
    expect(closed.textContent).toMatch(/needs a manager/);
  });

  it("refuses a deposit larger than the cash counted", async () => {
    const user = userEvent.setup();
    render(<DemoTill />);
    await user.selectOptions(await screen.findByLabelText("Drawer"), "demo-drawer");
    await user.click(screen.getByRole("button", { name: "Open till" }));
    await typeInto(user, "Counted cash (R)", "100");
    await typeInto(user, /Cash for bank deposit/, "150");
    expect((screen.getByRole("button", { name: "Close till" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("demo till access and isolation", () => {
  it("is for managers and admins only", () => {
    expect(canSee("budtender", "demo-till")).toBe(false);
    expect(canSee("manager", "demo-till")).toBe(true);
    expect(canSee("admin", "demo-till")).toBe(true);
    expect(canSee(null, "demo-till")).toBe(false);
  });

  it("the demo files can only reach the one read-only server function (guards against a future write)", () => {
    const src = readFileSync("src/components/admin/pos/DemoTill.tsx", "utf8");
    const logic = readFileSync("src/components/admin/pos/demo-logic.ts", "utf8");
    expect(src.match(/from "@\/lib\/[^"]+\.functions"/g)).toEqual(['from "@/lib/pos.functions"']);
    expect(src).toMatch(/import \{ getDemoTillCatalogFn \} from "@\/lib\/pos\.functions"/);
    expect(logic).not.toMatch(/\.functions|supabase|fetch\(/);
  });

  it("the server function behind it is read-only and manager-gated", () => {
    const s = readFileSync("src/lib/pos-data.server.ts", "utf8");
    const body = s.slice(
      s.indexOf("export async function getDemoTillCatalog"),
      s.indexOf("export async function getPosOverview"),
    );
    expect(body).toContain('assertRole(userId, "manager")');
    expect(body).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(|_audit|audit_log/);
  });
});
