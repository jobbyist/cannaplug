// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDemoSale,
  demoReceiptNumber,
  simulateSale,
  takeDemoStock,
} from "@/components/admin/pos/demo-logic";
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
  const sellOne = async () => {
    const user = userEvent.setup();
    render(<DemoTill />);
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
    expect(screen.getByText("1 practice sale")).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText("0 practice sales")).toBeTruthy());
    await user.clear(screen.getByLabelText("Search products"));
    await user.type(screen.getByLabelText("Search products"), "sour{Enter}");
    expect(await screen.findByLabelText("Quantity for Sour OG")).toBeTruthy();
    expect(server.getDemoTillCatalogFn).toHaveBeenCalledTimes(1); // reset does not even re-read
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
