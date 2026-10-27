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

import { InventoryPanel } from "@/components/admin/inventory/InventoryPanel";
import type { InventoryApi } from "@/components/admin/inventory/inventory-api";
import { row } from "./inventory-fixtures";

const ROWS = [
  row({ product_id: "p1", name: "Thai Haze", sku: "TH-1", on_hand: 10, available: 10 }),
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

  it("budtenders can look but get no Receive or Adjust buttons", async () => {
    render(<InventoryPanel canManage={false} api={fakeApi()} />);
    await screen.findByText("Thai Haze");
    expect(screen.queryByRole("button", { name: /Receive stock for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Adjust stock for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Receive delivery" })).toBeNull();
  });

  it("sets a counted amount in a modal and sends only the batch, the change and a reason", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<InventoryPanel canManage api={api} />);
    await user.click(await screen.findByRole("button", { name: "Adjust stock for Thai Haze" }));
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
    await user.click(await screen.findByRole("button", { name: "Receive stock for Thai Haze" }));
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
});
