// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/inventory.functions", () => ({
  listInventoryFn: vi.fn(),
  listStockHistoryFn: vi.fn(),
  setLowStockThresholdFn: vi.fn(),
}));
vi.mock("@/lib/pos.functions", () => ({
  adjustStockFn: vi.fn(),
  listBatchesFn: vi.fn(),
  receiveStockFn: vi.fn(),
}));
vi.mock("@/lib/stock-ops.functions", () => ({
  cancelStockTakeFn: vi.fn(),
  getStockTakeFn: vi.fn(),
  postStockTakeFn: vi.fn(),
  quickAdjustStockFn: vi.fn(),
  receiveDeliveryFn: vi.fn(),
  recordStockCountFn: vi.fn(),
  startStockTakeFn: vi.fn(),
}));

import { InventoryPanel } from "@/components/admin/inventory/InventoryPanel";
import type { InventoryApi, StockOpsApi } from "@/components/admin/inventory/inventory-api";
import { row } from "./inventory-fixtures";

const ROWS = [
  row({
    product_id: "p1",
    name: "Thai Haze",
    sku: "TH-1",
    barcode: "6001234567890",
    on_hand: 10,
    available: 10,
  }),
  row({ product_id: "p2", name: "Blue Dream", available: 2, on_hand: 2 }),
  row({ product_id: "p3", name: "Papers", category: "Accessories", available: 0, on_hand: 0 }),
];

function fakeApi() {
  const api = {
    list: vi.fn(async () => ROWS),
    history: vi.fn(async () => [
      {
        id: "m1",
        created_at: "2026-10-26T10:00:00Z",
        movement_type: "pos_sale",
        quantity_delta: -1,
        reason: "POS sale",
        batch_code: "TH-A",
        actor_name: "Tshepang",
      },
    ]),
    batches: vi.fn(async () => [
      {
        id: "b1",
        batch_code: "TH-A",
        qty_on_hand: 10,
        qty_held: 0,
        available: 10,
        expires_at: null,
      },
    ]),
    receive: vi.fn(async (_input: Parameters<InventoryApi["receive"]>[0]) => ({ batch_id: "b2" })),
    adjust: vi.fn(async (_input: Parameters<InventoryApi["adjust"]>[0]) => ({
      before: 10,
      after: 7,
    })),
    setThreshold: vi.fn(async () => ({})),
  };
  return api as typeof api & InventoryApi;
}

function fakeStockApi(
  take: Awaited<ReturnType<StockOpsApi["getStockTake"]>> = { take: null, lines: [] },
) {
  let view = take;
  const api = {
    getStockTake: vi.fn(async () => view),
    startStockTake: vi.fn(async (_i: Parameters<StockOpsApi["startStockTake"]>[0]) => {
      view = {
        take: {
          id: "11111111-1111-4111-8111-111111111111",
          status: "open" as const,
          note: null,
          category: null,
          started_at: "2026-11-05T10:00:00Z",
          closed_at: null,
        },
        lines: [],
      };
      return {};
    }),
    recordCount: vi.fn(async (i: Parameters<StockOpsApi["recordCount"]>[0]) => {
      const r = ROWS.find((x) => x.product_id === i.productId)!;
      view = {
        ...view,
        lines: [
          ...view.lines.filter((l) => l.product_id !== i.productId),
          {
            product_id: i.productId,
            name: r.name,
            category: r.category,
            sold_by_weight: false,
            expected: r.on_hand,
            counted: i.counted,
            difference: i.counted - r.on_hand,
            counted_at: "2026-11-05T10:05:00Z",
            unit_cost: 20,
          },
        ],
      };
      return { expected: r.on_hand, counted: i.counted, difference: i.counted - r.on_hand };
    }),
    recordCounts: vi.fn(async (i: Parameters<StockOpsApi["recordCounts"]>[0]) => {
      for (const l of i.lines)
        await api.recordCount({
          stockTakeId: i.stockTakeId,
          productId: l.productId,
          counted: l.counted,
          key: "k",
        });
      return { saved: i.lines.length, failed: [] };
    }),
    postStockTake: vi.fn(async (_i: Parameters<StockOpsApi["postStockTake"]>[0]) => ({
      lines: 1,
      changed: 1,
      units_added: 0,
      units_removed: 3,
    })),
    cancelStockTake: vi.fn(async () => ({})),
    quickAdjust: vi.fn(async (_i: Parameters<StockOpsApi["quickAdjust"]>[0]) => ({
      before: 10,
      after: 8,
    })),
    receiveDelivery: vi.fn(async (_i: Parameters<StockOpsApi["receiveDelivery"]>[0]) => ({
      lines: 1,
      units: 12,
      batch_code: "DEL-20261105-INV-7",
    })),
  };
  return api as typeof api & StockOpsApi;
}

afterEach(cleanup);

describe("Inventory tab", () => {
  it("shows counts, filters by search and by clicking a stat card", async () => {
    const user = userEvent.setup();
    render(<InventoryPanel canManage api={fakeApi()} />);
    await screen.findByText("Thai Haze");
    expect(screen.getByText("3 of 3 products")).toBeTruthy();
    await user.type(screen.getByLabelText("Search inventory"), "th-1");
    expect(screen.getByText("1 of 3 products")).toBeTruthy();
    await user.click(screen.getByText("Clear filters"));
    await user.click(screen.getByRole("button", { name: /Out of stock/ }));
    const list = screen.getByRole("list", { name: "Inventory" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Papers")).toBeTruthy();
  });

  it("budtenders can look and count, but get no Add, Remove or Receive buttons", async () => {
    render(<InventoryPanel canManage={false} api={fakeApi()} stockApi={fakeStockApi()} />);
    await screen.findByText("Thai Haze");
    expect(screen.queryByRole("button", { name: /Add stock for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove stock for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Receive delivery" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stock take" })).toBeTruthy();
  });

  it("sets a counted amount in a modal and sends only the batch, the change and a reason", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<InventoryPanel canManage api={api} />);
    await user.click(await screen.findByRole("button", { name: "More actions for Thai Haze" }));
    await user.click(await screen.findByRole("menuitem", { name: /Adjust a batch/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/Batch TH-A: 10 on hand/)).toBeTruthy());
    await user.type(within(dialog).getByLabelText("How many did you count?"), "7");
    expect(within(dialog).getByTestId("stock-preview").textContent).toMatch(/10 → 7/);
    await user.click(within(dialog).getByRole("button", { name: "Save adjustment" }));
    await waitFor(() => expect(api.adjust).toHaveBeenCalled());
    expect(api.adjust.mock.calls[0]![0]).toMatchObject({
      batchId: "b1",
      delta: -3,
      reason: "Stock count correction",
    });
    expect(await screen.findByText(/10 → 7. Recorded in the audit log/)).toBeTruthy();
  });

  it("receives a delivery into a new, suggested batch with quick amounts", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<InventoryPanel canManage api={api} />);
    await user.click(await screen.findByRole("button", { name: "More actions for Thai Haze" }));
    await user.click(await screen.findByRole("menuitem", { name: /Receive into a batch/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "+10" }));
    await user.click(within(dialog).getByRole("button", { name: "+5" }));
    expect(within(dialog).getByTestId("stock-preview").textContent).toMatch(/10 → 25/);
    await user.click(within(dialog).getByRole("button", { name: "Receive 15 units" }));
    await waitFor(() => expect(api.receive).toHaveBeenCalled());
    const sent = api.receive.mock.calls[0]![0];
    expect(sent).toMatchObject({ productId: "p1", quantity: 15 });
    expect(sent!.batchCode).toMatch(/^TH1-\d{6}$/);
  });

  it("opens the stock history", async () => {
    const user = userEvent.setup();
    render(<InventoryPanel canManage api={fakeApi()} />);
    await user.click(await screen.findByRole("button", { name: "More actions for Thai Haze" }));
    await user.click(await screen.findByRole("menuitem", { name: /Stock history/ }));
    expect(await screen.findByText("Till sale")).toBeTruthy();
  });

  it("removes stock for a product with a reason, without choosing a batch", async () => {
    const user = userEvent.setup();
    const stock = fakeStockApi();
    render(<InventoryPanel canManage api={fakeApi()} stockApi={stock} />);
    await user.click(await screen.findByRole("button", { name: "Remove stock for Thai Haze" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("How many to remove?"), "2");
    await user.click(within(dialog).getByRole("button", { name: "Remove 2 units" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/reason/);
    expect(stock.quickAdjust).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Damaged" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove 2 units" }));
    await waitFor(() => expect(stock.quickAdjust).toHaveBeenCalled());
    expect(stock.quickAdjust.mock.calls[0]![0]).toMatchObject({
      productId: "p1",
      delta: -2,
      reason: "Damaged",
    });
    expect(await screen.findByText(/Thai Haze: 10 → 8 on hand/)).toBeTruthy();
  });

  it("receives a delivery by scanning a barcode, sending only ids and quantities", async () => {
    const user = userEvent.setup();
    const stock = fakeStockApi();
    render(<InventoryPanel canManage api={fakeApi()} stockApi={stock} />);
    await user.click(await screen.findByRole("button", { name: "Receive delivery" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText("Invoice or delivery note no. (optional)"),
      "INV 7",
    );
    // A USB scanner types the code then presses Enter.
    await user.type(within(dialog).getByLabelText(/Scan a barcode/), "6001234567890{Enter}");
    const qty = within(dialog).getByLabelText("Quantity");
    await user.clear(qty);
    await user.type(qty, "12");
    await user.click(within(dialog).getByRole("button", { name: "Receive 1 product (12 units)" }));
    await waitFor(() => expect(stock.receiveDelivery).toHaveBeenCalled());
    expect(stock.receiveDelivery.mock.calls[0]![0]).toMatchObject({
      reference: "INV 7",
      lines: [{ productId: "p1", quantity: 12, unitCost: null, expiresOn: null }],
    });
    expect(await screen.findByText(/Delivery received: 1 products, 12 units/)).toBeTruthy();
  });

  it("a manager starts a count, staff count blind, and the manager reviews and posts", async () => {
    const user = userEvent.setup();
    const stock = fakeStockApi();
    render(<InventoryPanel canManage api={fakeApi()} stockApi={stock} />);
    await user.click(await screen.findByRole("button", { name: "Stock take" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: "Start counting" }));
    dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findByTestId("count-progress")).textContent).toBe(
      "0 of 3 counted",
    );
    await user.type(within(dialog).getByLabelText(/Scan a barcode/), "thai{Enter}");
    // Blind count: the system number is not shown while counting.
    expect(within(dialog).queryByText(/10 on hand/)).toBeNull();
    await user.type(within(dialog).getByLabelText(/How many are on the shelf/), "7");
    await user.click(within(dialog).getByRole("button", { name: "Save count" }));
    await waitFor(() => expect(stock.recordCount).toHaveBeenCalled());
    expect(stock.recordCount.mock.calls[0]![0]).toMatchObject({ productId: "p1", counted: 7 });
    expect((await within(dialog).findByTestId("count-progress")).textContent).toBe(
      "1 of 3 counted",
    );
    await user.click(within(dialog).getByRole("button", { name: /Review differences/ }));
    const summary = within(dialog).getByTestId("variance-summary");
    expect(summary.textContent).toMatch(/Short−3R60/);
    expect(within(dialog).getByText(/2 products were not counted/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Post count (1 correction)" }));
    await waitFor(() => expect(stock.postStockTake).toHaveBeenCalled());
    expect(await screen.findByText(/Count posted: 1 of 1 products corrected/)).toBeTruthy();
  });

  it("staff upload a filled count sheet: checked first, then saved in one go", async () => {
    const user = userEvent.setup();
    const stock = fakeStockApi({
      take: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "open",
        note: null,
        category: null,
        started_at: "2026-11-05T10:00:00Z",
        closed_at: null,
      },
      lines: [],
    });
    render(<InventoryPanel canManage={false} api={fakeApi()} stockApi={stock} />);
    await user.click(await screen.findByRole("button", { name: "Stock take" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("count-sheet");
    const file = new File(
      [
        "sku,barcode,name,category,unit,counted\nTH-1,,Thai Haze,Flower,units,8\n,,Blue Dream,Flower,units,\nX-9,,Ghost,Flower,units,3\n",
      ],
      "count.csv",
      { type: "text/csv" },
    );
    await user.upload(within(dialog).getByLabelText("Count sheet CSV"), file);
    const preview = await within(dialog).findByTestId("count-sheet-preview");
    expect(preview.textContent).toMatch(/1 to save/);
    expect(preview.textContent).toMatch(/1 left blank/);
    expect(preview.textContent).toMatch(/Line 4 \(Ghost\): Not a product in this count/);
    expect(stock.recordCounts).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save 1 count" }));
    await waitFor(() => expect(stock.recordCounts).toHaveBeenCalled());
    const sent = stock.recordCounts.mock.calls[0]![0];
    // Only ids and quantities leave the browser.
    expect(sent.lines).toEqual([{ productId: "p1", counted: 8 }]);
    expect(Object.keys(sent).sort()).toEqual(["key", "lines", "stockTakeId"]);
    expect(await within(dialog).findByText(/Count sheet saved: 1 product counted/)).toBeTruthy();
    expect((await within(dialog).findByTestId("count-progress")).textContent).toBe(
      "1 of 3 counted",
    );
  });

  it("budtenders can count but not review or post", async () => {
    const user = userEvent.setup();
    const stock = fakeStockApi({
      take: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "open",
        note: null,
        category: null,
        started_at: "2026-11-05T10:00:00Z",
        closed_at: null,
      },
      lines: [],
    });
    render(<InventoryPanel canManage={false} api={fakeApi()} stockApi={stock} />);
    await user.click(await screen.findByRole("button", { name: "Stock take" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByLabelText(/Scan a barcode/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Review differences/ })).toBeNull();
  });
});
