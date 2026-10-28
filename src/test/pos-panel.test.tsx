// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const overview = {
  role: "budtender",
  isManager: false,
  drawers: [{ id: "d1", name: "Front counter", location: null, is_active: true, in_use: true }],
  mySession: { id: "s1", drawer_id: "d1", opened_at: new Date().toISOString(), opening_float: 500 },
  sessionSummary: { salesCount: 0, salesTotal: 0 },
  sales: [],
  pendingApprovals: [],
  catalog: [
    {
      id: "p1",
      slug: "blue-gelato",
      name: "Blue Gelato",
      category: "Flower",
      subcategory: "Greenhouse",
      strain_type: "Hybrid",
      unit: "per gram",
      price_rand: 50,
      available: 5,
    },
    {
      id: "p2",
      slug: "sour-og",
      name: "Sour OG",
      category: "Flower",
      subcategory: "Greenhouse",
      strain_type: "Sativa",
      unit: "per gram",
      price_rand: 70,
      available: 0,
    },
    {
      id: "p3",
      slug: "white-widow",
      name: "White Widow",
      category: "Flower",
      subcategory: "Greendoor",
      strain_type: "Hybrid",
      unit: "per gram",
      price_rand: 70,
      available: 20,
    },
  ],
};

const server = vi.hoisted(() => ({
  getPosOverviewFn: vi.fn(),
  completePosSaleFn: vi.fn(),
  searchPosCustomersFn: vi.fn(),
  openPosSessionFn: vi.fn(),
  closePosSessionFn: vi.fn(),
  reviewPosSessionFn: vi.fn(),
  refundPosSaleFn: vi.fn(),
  voidPosSaleFn: vi.fn(),
  findPosSaleFn: vi.fn(),
  upsertDrawerFn: vi.fn(),
  listBatchesFn: vi.fn(),
  receiveStockFn: vi.fn(),
  adjustStockFn: vi.fn(),
}));
vi.mock("@/lib/pos.functions", () => server);
const customersApi = vi.hoisted(() => ({ listCustomersFn: vi.fn() }));
vi.mock("@/lib/admin.functions", () => customersApi);

import { PosPanel } from "@/components/admin/pos/PosPanel";

const saleResult = {
  sale: {
    sale_id: "sale-1",
    receipt_number: "POS-260929-000001",
    total: 50,
    items: [{ product_id: "p1", name: "Blue Gelato", quantity: 1, unit_price: 50, line_total: 50 }],
    tenders: [{ method: "cash", amount: 50, reference: null }],
  },
  loyalty: { accrued: false, reason: "no_customer" },
};

async function ready() {
  const user = userEvent.setup();
  render(<PosPanel />);
  const search = await screen.findByLabelText("Search products");
  return { user, search };
}

beforeEach(() => {
  Object.values(server).forEach((f) => f.mockReset());
  server.getPosOverviewFn.mockResolvedValue(overview);
  server.completePosSaleFn.mockResolvedValue(saleResult);
});
afterEach(() => cleanup());

describe("POS screen — speed-first search & keyboard controls", () => {
  it("autofocuses the search box so a cashier can start typing immediately", async () => {
    const { search } = await ready();
    expect(document.activeElement).toBe(search);
  });

  it("type + Enter adds the top match to the basket and returns focus to search", async () => {
    const { user, search } = await ready();
    await user.type(search, "gelato{Enter}");
    const basket = screen.getByText("Basket").closest("div")!.parentElement!;
    expect(within(basket).getByText("Blue Gelato")).toBeTruthy();
    expect(within(basket).getAllByText(/R50/).length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(search);
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("arrow keys change the highlighted result before Enter", async () => {
    const { user, search } = await ready();
    await user.type(search, "flower");
    // In-stock items rank first: Blue Gelato, White Widow, then out-of-stock Sour OG.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(await screen.findByLabelText("Quantity for White Widow")).toBeTruthy();
  });

  it("'3*gelato' adds three units in one keystroke sequence", async () => {
    const { user, search } = await ready();
    await user.type(search, "3*gelato{Enter}");
    expect(
      ((await screen.findByLabelText("Quantity for Blue Gelato")) as HTMLInputElement).value,
    ).toBe("3");
    expect(screen.getAllByText(/R150/).length).toBeGreaterThan(0);
  });

  it("every staff member on the till gets the sale (discount) button", async () => {
    const { user, search } = await ready();
    await user.type(search, "sour");
    expect(screen.getByRole("button", { name: "Put on sale: Sour OG" })).toBeTruthy();
  });

  it("out-of-stock products cannot be added", async () => {
    const { user, search } = await ready();
    await user.type(search, "sour{Enter}");
    expect(screen.queryByLabelText("Quantity for Sour OG")).toBeNull();
    expect((screen.getByRole("button", { name: /^Sour OG/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("quantity is keyboard-adjustable and clamped to displayed availability", async () => {
    const { user, search } = await ready();
    await user.type(search, "gelato{Enter}");
    const qty = (await screen.findByLabelText("Quantity for Blue Gelato")) as HTMLInputElement;
    await user.click(qty);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(qty.value).toBe("3");
    await user.keyboard("{ArrowDown}");
    expect(qty.value).toBe("2");
    await user.keyboard("{Delete}");
    expect(screen.queryByLabelText("Quantity for Blue Gelato")).toBeNull();
    // Typing an absurd quantity is clamped to what is available (5); the server still re-checks.
    await user.type(search, "gelato{Enter}");
    const again = (await screen.findByLabelText("Quantity for Blue Gelato")) as HTMLInputElement;
    await user.clear(again);
    await user.type(again, "999");
    expect(again.value).toBe("5");
  });
});

describe("POS screen — multi-tender capture", () => {
  const withGelato = async () => {
    const ctx = await ready();
    await ctx.user.type(ctx.search, "gelato{Enter}");
    return ctx;
  };
  // "Complete sale…" while idle, "Completing…" while a request is in flight.
  const completeButton = () =>
    screen.getByRole("button", { name: /Complet(e|ing)/ }) as HTMLButtonElement;

  it("enables completion only when tenders equal the total to the cent", async () => {
    const { user } = await withGelato();
    expect(screen.queryByRole("button", { name: /Complete/ })).toBeTruthy();
    expect(completeButton().disabled).toBe(true); // no tender yet
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    expect(completeButton().disabled).toBe(false);
    const amount = screen.getByLabelText("Tender amount");
    await user.clear(amount);
    await user.type(amount, "49.99");
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByText(/Remaining/)).toBeTruthy();
    await user.clear(amount);
    await user.type(amount, "50.01");
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByText(/Over by/)).toBeTruthy();
  });

  it("supports split tenders and demands a reference for card/EFT/PayPal", async () => {
    const { user } = await withGelato();
    await user.click(screen.getByRole("button", { name: /Split tender/ }));
    const amounts = screen.getAllByLabelText("Tender amount");
    await user.clear(amounts[0]!); // rows are pre-filled with the remaining balance
    await user.type(amounts[0]!, "20");
    await user.click(screen.getByRole("button", { name: /Split tender/ }));
    const methods = screen.getAllByLabelText("Tender method");
    await user.selectOptions(methods[1]!, "card");
    await user.clear(screen.getAllByLabelText("Tender amount")[1]!);
    await user.type(screen.getAllByLabelText("Tender amount")[1]!, "30");
    expect(completeButton().disabled).toBe(true); // card needs a reference
    await user.type(screen.getByLabelText("card reference"), "SLIP-9911");
    expect(completeButton().disabled).toBe(false);
  });

  it("two payments with the same card reference are caught before sending, with a plain reason", async () => {
    const { user } = await withGelato();
    await user.click(screen.getByRole("button", { name: /Split tender/ }));
    await user.click(screen.getByRole("button", { name: /Split tender/ }));
    const methods = screen.getAllByLabelText("Tender method");
    await user.selectOptions(methods[0]!, "card");
    await user.selectOptions(methods[1]!, "card");
    const amounts = screen.getAllByLabelText("Tender amount");
    await user.clear(amounts[0]!);
    await user.type(amounts[0]!, "25");
    await user.clear(amounts[1]!);
    await user.type(amounts[1]!, "25");
    const refs = screen.getAllByLabelText("card reference");
    await user.type(refs[0]!, "04YImt023013");
    await user.type(refs[1]!, "04YImt023014");
    expect(completeButton().disabled).toBe(false); // two different slips are fine
    await user.clear(refs[1]!);
    await user.type(refs[1]!, "04YImt023013");
    expect(completeButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/04YImt023013.*more than one payment/);
    await user.clear(refs[1]!);
    await user.type(refs[1]!, "04YImt023014");
    expect(completeButton().disabled).toBe(false);
    expect(screen.queryByText(/more than one payment/)).toBeNull();
  });

  it("a 100% discount on the whole order completes as a free sale with no payment", async () => {
    server.completePosSaleFn.mockResolvedValue({
      ...saleResult,
      sale: { ...saleResult.sale, total: 0, tenders: [] },
    });
    const { user } = await withGelato();
    await user.click(screen.getByRole("button", { name: /Exact cash/ })); // a payment row typed first
    expect(completeButton().disabled).toBe(false);
    await user.type(screen.getByLabelText("Order discount"), "100");
    expect(screen.getByText(/This sale is free \(100% discount\)/)).toBeTruthy();
    expect(screen.queryByLabelText("Tender amount")).toBeNull(); // payment rows are gone
    expect(completeButton().textContent).toMatch(/Complete free sale · R0/);
    expect(completeButton().disabled).toBe(true); // the reason is still required
    await user.type(screen.getByLabelText("Discount reason"), "Damaged packaging");
    expect(completeButton().disabled).toBe(false);
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalledTimes(1));
    expect(server.completePosSaleFn.mock.calls[0]![0].data).toMatchObject({
      tenders: [],
      orderDiscount: { kind: "percent", value: "100" },
      discountReason: "Damaged packaging",
    });
  });

  it("a 100% discount on the only item works too, and over 100% is still refused on screen", async () => {
    server.completePosSaleFn.mockResolvedValue(saleResult);
    const { user } = await withGelato();
    await user.click(screen.getByText("Discount this item"));
    const line = screen.getAllByLabelText(/Discount for/)[1]!; // [0] is the type menu
    await user.type(line, "100.5");
    expect(screen.getByRole("alert").textContent).toMatch(/Check the discount/);
    expect(completeButton().disabled).toBe(true);
    await user.clear(line);
    await user.type(line, "100");
    await user.type(screen.getByLabelText("Discount reason"), "Free sample");
    expect(completeButton().textContent).toMatch(/Complete free sale/);
    expect(completeButton().disabled).toBe(false);
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalled());
    const data = server.completePosSaleFn.mock.calls[0]![0].data;
    expect(data.tenders).toEqual([]);
    expect(data.items[0].discount).toEqual({ kind: "percent", value: "100" });
  });

  it("any other discount still needs payments that equal the discounted total", async () => {
    const { user } = await withGelato();
    await user.type(screen.getByLabelText("Order discount"), "50");
    await user.type(screen.getByLabelText("Discount reason"), "Half price");
    expect(completeButton().disabled).toBe(true); // nothing tendered yet
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    expect(screen.getByLabelText("Tender amount")).toHaveProperty("value", "25.00");
    expect(completeButton().disabled).toBe(false);
  });

  it("sends ONLY product ids, quantities, tender amounts and an idempotency key — never a price or total", async () => {
    const { user } = await withGelato();
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalledTimes(1));
    const { data } = server.completePosSaleFn.mock.calls[0]![0];
    expect(data).toEqual({
      sessionId: "s1",
      items: [{ product_id: "p1", quantity: 1 }],
      tenders: [{ method: "cash", amount: "50.00" }],
      customerId: null,
      orderDiscount: null,
      discountReason: null,
      key: expect.stringMatching(/^[\w-]{8,}$/),
    });
    expect(JSON.stringify(data)).not.toMatch(/price|total|stock|available|actor|user/i);
    expect(await screen.findByText("POS-260929-000001")).toBeTruthy();
  });

  it("discounts an item and the whole order, needs a reason, and sends only kind and value", async () => {
    const { user } = await withGelato(); // Blue Gelato, R50
    await user.click(screen.getByText("Discount this item"));
    await user.type(screen.getByLabelText("Discount for Blue Gelato"), "10");
    await user.type(screen.getByLabelText("Order discount"), "R 5");
    // R50 less 10% is R45; the order discount is R5 off, so R40 is due.
    await user.selectOptions(screen.getByLabelText("Order discount type"), "amount");
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    // A discount needs a reason before the sale can be completed.
    expect(completeButton().disabled).toBe(true);
    await user.type(screen.getByLabelText("Discount reason"), "Loyal customer");
    expect(completeButton().disabled).toBe(false);
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalledTimes(1));
    const { data } = server.completePosSaleFn.mock.calls[0]![0];
    expect(data.items).toEqual([
      { product_id: "p1", quantity: 1, discount: { kind: "percent", value: "10" } },
    ]);
    expect(data.orderDiscount).toEqual({ kind: "amount", value: "5" });
    expect(data.discountReason).toBe("Loyal customer");
    expect(data.tenders).toEqual([{ method: "cash", amount: "40.00" }]);
  });

  it("blocks completion while a discount is not a valid number", async () => {
    const { user } = await withGelato();
    await user.click(screen.getByText("Discount this item"));
    await user.type(screen.getByLabelText("Discount for Blue Gelato"), "150");
    expect(screen.getByRole("alert").textContent).toMatch(/Check the discount/);
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    expect(completeButton().disabled).toBe(true);
  });

  it("F9 completes the sale from the keyboard, and rapid double-submits send only one request", async () => {
    let release!: (v: unknown) => void;
    server.completePosSaleFn.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const { user } = await withGelato();
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.keyboard("{F9}{F9}{Control>}{Enter}{/Control}");
    await user.click(completeButton());
    expect(server.completePosSaleFn).toHaveBeenCalledTimes(1);
    release(saleResult);
    expect(await screen.findByText("POS-260929-000001")).toBeTruthy();
  });

  it("a network failure keeps the basket and RE-USES the idempotency key on retry (safe replay)", async () => {
    server.completePosSaleFn
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(saleResult);
    const { user } = await withGelato();
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(completeButton());
    expect(await screen.findByRole("alert")).toBeTruthy();
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalledTimes(2));
    const [k1, k2] = server.completePosSaleFn.mock.calls.map((c) => c[0].data.key);
    expect(k1).toBe(k2);
    expect(await screen.findByText("POS-260929-000001")).toBeTruthy();
  });

  it("changing the basket after a failure uses a NEW key (the server would reject key reuse with a different payload)", async () => {
    server.completePosSaleFn
      .mockRejectedValueOnce(new Error("Not enough stock available"))
      .mockResolvedValueOnce(saleResult);
    const { user, search } = await withGelato();
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(completeButton());
    expect(await screen.findByRole("alert")).toBeTruthy();
    // Add another item: the exact-cash tender becomes stale, so re-tender for the new total.
    await user.type(search, "widow{Enter}");
    const amount = screen.getByLabelText("Tender amount");
    await user.clear(amount);
    await user.type(amount, "120");
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalledTimes(2));
    const [k1, k2] = server.completePosSaleFn.mock.calls.map((c) => c[0].data.key);
    expect(k1).not.toBe(k2);
  });

  it("passes the chosen customer id so loyalty can accrue after commit, and surfaces the credited points", async () => {
    server.completePosSaleFn.mockResolvedValue({
      ...saleResult,
      loyalty: { accrued: true, points: 5 },
    });
    const { user } = await withGelato();
    server.searchPosCustomersFn.mockResolvedValue([
      {
        id: "c1",
        full_name: "Thandi Ndlovu",
        phone: "0821110001",
        email: "t@x.co",
        is_staff: false,
      },
    ]);
    await user.type(screen.getByLabelText("Find customer"), "Thandi");
    await user.click(await screen.findByRole("button", { name: /Thandi Ndlovu/ }));
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalled());
    expect(server.completePosSaleFn.mock.calls[0]![0].data.customerId).toBe("c1");
    expect(await screen.findByText(/\+5 loyalty points credited/)).toBeTruthy();
  });

  it("a staff member on the sale gets the staff rate automatically: 20% off, a Staff badge, no reason needed", async () => {
    server.completePosSaleFn.mockResolvedValue({
      ...saleResult,
      sale: { ...saleResult.sale, total: 40, staff_purchase: true },
      staff_purchase: true,
    });
    const { user } = await withGelato(); // R50
    server.searchPosCustomersFn.mockResolvedValue([
      { id: "s1", full_name: "Baatseba K", phone: null, email: "b@x.co", is_staff: true },
    ]);
    await user.type(screen.getByLabelText("Find customer"), "Baatseba");
    const hit = await screen.findByRole("button", { name: /Baatseba K/ });
    expect(within(hit).getByTestId("staff-badge")).toBeTruthy();
    await user.click(hit);
    expect((await screen.findByTestId("staff-rate-note")).textContent).toMatch(/20% off/);
    // the total is the staff price: 50 - 10 = 40, so exact cash is R40.00 and no reason is asked for
    expect(screen.queryByLabelText("Discount reason")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    expect((screen.getByLabelText("Tender amount") as HTMLInputElement).value).toBe("40.00");
    await user.click(completeButton());
    await waitFor(() => expect(server.completePosSaleFn).toHaveBeenCalled());
    const sent = server.completePosSaleFn.mock.calls[0]![0].data;
    expect(sent.customerId).toBe("s1");
    expect(sent.discountReason).toBeNull();
    expect(sent.orderDiscount).toBeNull();
    // the browser sends ids and tenders only: never a price, a role or a staff flag
    expect(JSON.stringify(sent)).not.toMatch(/staff|role|price/i);
    expect((await screen.findAllByTestId("staff-badge")).length).toBeGreaterThan(0);
  });

  it("a member (not staff) pays full price and sees no staff note", async () => {
    const { user } = await withGelato();
    server.searchPosCustomersFn.mockResolvedValue([
      { id: "c1", full_name: "Thandi Ndlovu", phone: null, email: null, is_staff: false },
    ]);
    await user.type(screen.getByLabelText("Find customer"), "Thandi");
    await user.click(await screen.findByRole("button", { name: /Thandi Ndlovu/ }));
    expect(screen.queryByTestId("staff-rate-note")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    expect((screen.getByLabelText("Tender amount") as HTMLInputElement).value).toBe("50.00");
  });

  it("shows a retry note (not a failed sale) when loyalty accrual is pending after a committed sale", async () => {
    server.completePosSaleFn.mockResolvedValue({
      ...saleResult,
      loyalty: { accrued: false, pending: true },
    });
    const { user } = await withGelato();
    server.searchPosCustomersFn.mockResolvedValue([
      {
        id: "c1",
        full_name: "Thandi Ndlovu",
        phone: "0821110001",
        email: "t@x.co",
        is_staff: false,
      },
    ]);
    await user.type(screen.getByLabelText("Find customer"), "Thandi");
    await user.click(await screen.findByRole("button", { name: /Thandi Ndlovu/ }));
    await user.click(screen.getByRole("button", { name: /Exact cash/ }));
    await user.click(completeButton());
    expect(await screen.findByText(/Loyalty points will be credited on retry/)).toBeTruthy();
    expect(screen.getByText("POS-260929-000001")).toBeTruthy(); // the sale itself succeeded
  });
});

describe("POS screen — till gating", () => {
  it("asks the cashier to open a till when no session is open and hides the sale screen", async () => {
    server.getPosOverviewFn.mockResolvedValue({
      ...overview,
      mySession: null,
      sessionSummary: null,
      drawers: [
        { id: "d1", name: "Front counter", location: null, is_active: true, in_use: false },
      ],
    });
    render(<PosPanel />);
    expect(await screen.findByRole("heading", { name: /Open till/i })).toBeTruthy();
    expect(screen.queryByLabelText("Search products")).toBeNull();
  });

  it("does not reveal expected cash while the till is open (blind count) and hides manager tools from cashiers", async () => {
    render(<PosPanel />);
    await screen.findByLabelText("Search products");
    expect(screen.queryByText(/^Expected cash$/i)).toBeNull(); // no figure is shown before the count
    expect(screen.getByText(/Expected cash is revealed after you submit the count/i)).toBeTruthy();
    expect(screen.queryByText(/Stock control/i)).toBeNull();
    expect(screen.queryByText(/Cash variance approvals/i)).toBeNull();
  });

  it("shows stock control and approvals to managers", async () => {
    server.getPosOverviewFn.mockResolvedValue({
      ...overview,
      role: "manager",
      isManager: true,
      pendingApprovals: [
        {
          id: "s9",
          drawer_name: "Back",
          closed_at: null,
          expected_cash: 500,
          actual_cash: 470,
          variance: -30,
          closed_by: "u1",
          cashier_name: "Sipho",
        },
      ],
    });
    render(<PosPanel />);
    expect(await screen.findByText(/Stock control/i)).toBeTruthy();
    expect(screen.getByText(/Cash variance approvals/i)).toBeTruthy();
  });
});
