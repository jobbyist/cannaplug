// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StockOpsApi, StockTakeView } from "@/components/admin/inventory/inventory-api";
import { BulkStockTakeDialog } from "@/components/admin/inventory/BulkStockTakeDialog";
import { QuickAdjustDialog } from "@/components/admin/inventory/StockOpsDialogs";
import { StockTakeDialog } from "@/components/admin/inventory/StockTakeDialog";
import { row } from "./inventory-fixtures";

/** 25 Nov 2026: decimal stock. Weighed products take one decimal place (27.4 g or 27,4); everything else is whole. */

const ROWS = [
  row({
    product_id: "g1",
    name: "Gram Flower",
    sku: "GF-1",
    sold_by_weight: true,
    on_hand: 30,
    available: 30,
  }),
  row({ product_id: "u1", name: "Pre-roll", sku: "PR-1", on_hand: 10, available: 10 }),
];
const TAKE = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "open" as const,
  note: null,
  category: null,
  started_at: "2026-11-25T08:00:00Z",
  closed_at: null,
};

function fakeApi(initial: StockTakeView = { take: TAKE, lines: [] }) {
  let view = initial;
  const api = {
    getStockTake: vi.fn(async () => view),
    startStockTake: vi.fn(async () => {
      view = { take: TAKE, lines: [] };
      return { stock_take_id: TAKE.id };
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
            sold_by_weight: r.sold_by_weight,
            expected: r.on_hand,
            counted: i.counted,
            difference: Math.round((i.counted - r.on_hand) * 10) / 10,
            counted_at: "2026-11-25T08:05:00Z",
            unit_cost: null,
          },
        ],
      };
      return { expected: r.on_hand, counted: i.counted, difference: 0 };
    }),
    recordCounts: vi.fn(async (i: Parameters<StockOpsApi["recordCounts"]>[0]) => ({
      saved: i.lines.length,
      failed: [],
    })),
    postStockTake: vi.fn(),
    cancelStockTake: vi.fn(),
    quickAdjust: vi.fn(async (_i: Parameters<StockOpsApi["quickAdjust"]>[0]) => ({
      before: 30,
      after: 17.5,
    })),
    receiveDelivery: vi.fn(),
  };
  return api as typeof api & StockOpsApi;
}

afterEach(cleanup);

async function openCount(api = fakeApi()) {
  const user = userEvent.setup();
  render(
    <StockTakeDialog
      open
      onOpenChange={() => {}}
      rows={ROWS}
      categories={["Flower"]}
      canManage
      api={api}
      onDone={async () => {}}
    />,
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByLabelText(/Scan a barcode/);
  return { user, dialog, api };
}

describe("stock take with decimals", () => {
  it("a weighed product is counted to one decimal, typed with a point or a comma", async () => {
    const { user, dialog, api } = await openCount();
    await user.type(within(dialog).getByLabelText(/Scan a barcode/), "gram{Enter}");
    const box = within(dialog).getByLabelText(/How many are on the shelf/);
    expect(within(dialog).getByText(/Grams to one decimal place/)).toBeTruthy();
    await user.type(box, "27,4");
    await user.click(within(dialog).getByRole("button", { name: "Save count" }));
    await waitFor(() => expect(api.recordCount).toHaveBeenCalled());
    expect(api.recordCount.mock.calls[0]![0]).toMatchObject({ productId: "g1", counted: 27.4 });
    expect(await within(dialog).findByText("Gram Flower: 27,4 saved.")).toBeTruthy();
  });

  it("a third decimal can't be typed", async () => {
    const { user, dialog } = await openCount();
    await user.type(within(dialog).getByLabelText(/Scan a barcode/), "gram{Enter}");
    const box = within(dialog).getByLabelText(/How many are on the shelf/) as HTMLInputElement;
    await user.type(box, "27.456");
    expect(box.value).toBe("27.4");
  });

  it("a product counted in whole units refuses a decimal, with the reason, instead of turning 2.5 into 25", async () => {
    const { user, dialog, api } = await openCount();
    await user.type(within(dialog).getByLabelText(/Scan a barcode/), "pre-roll{Enter}");
    const box = within(dialog).getByLabelText(/How many are on the shelf/) as HTMLInputElement;
    expect(within(dialog).getByText("Whole units.")).toBeTruthy();
    await user.type(box, "2.5");
    expect(box.value).toBe("2.5");
    await user.click(within(dialog).getByRole("button", { name: "Save count" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/whole units/);
    expect(api.recordCount).not.toHaveBeenCalled();
  });

  it("the review shows exact decimal differences", async () => {
    const api = fakeApi({
      take: TAKE,
      lines: [
        {
          product_id: "g1",
          name: "Gram Flower",
          category: "Flower",
          sold_by_weight: true,
          expected: 30,
          counted: 27.4,
          difference: -2.6,
          counted_at: "2026-11-25T08:05:00Z",
          unit_cost: null,
        },
        {
          product_id: "u1",
          name: "Pre-roll",
          category: "Flower",
          sold_by_weight: false,
          expected: 10,
          counted: 10,
          difference: 0,
          counted_at: "2026-11-25T08:06:00Z",
          unit_cost: null,
        },
      ],
    });
    const { user, dialog } = await openCount(api);
    await user.click(within(dialog).getByRole("button", { name: /Review differences/ }));
    const summary = within(dialog).getByTestId("variance-summary");
    expect(summary.textContent).toMatch(/Short−2,6/);
    expect(summary.textContent).toMatch(/Over\+0/);
    const rowText = within(dialog).getByText("Gram Flower").closest("tr")!.textContent!;
    expect(rowText).toMatch(/30/);
    expect(rowText).toMatch(/27,4/);
    expect(rowText).toMatch(/2,6/);
    expect(within(dialog).getByRole("button", { name: "Post count (1 correction)" })).toBeTruthy();
  });
});

describe("quick add / remove with decimals", () => {
  it("a weighed product can be reduced by 12.5 g, typed with a comma", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(
      <QuickAdjustDialog
        open
        onOpenChange={() => {}}
        mode="remove"
        row={ROWS[0]!}
        api={api}
        onDone={async () => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "12,5");
    await user.click(within(dialog).getByRole("button", { name: "Damaged" }));
    await user.click(within(dialog).getByRole("button", { name: /Remove 12,5 g/ }));
    await waitFor(() => expect(api.quickAdjust).toHaveBeenCalled());
    expect(api.quickAdjust.mock.calls[0]![0]).toMatchObject({ productId: "g1", delta: -12.5 });
  });

  it("a whole-unit product refuses 1.5, and says why", async () => {
    const api = fakeApi();
    const user = userEvent.setup();
    render(
      <QuickAdjustDialog
        open
        onOpenChange={() => {}}
        mode="remove"
        row={ROWS[1]!}
        api={api}
        onDone={async () => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "1.5");
    await user.click(within(dialog).getByRole("button", { name: "Damaged" }));
    await user.click(within(dialog).getByRole("button", { name: /^Remove/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/whole units/);
    expect(api.quickAdjust).not.toHaveBeenCalled();
  });
});

describe("bulk stock take (CSV) with decimals", () => {
  it("loads decimal counts for weighed products and refuses decimals for whole-unit ones", async () => {
    const api = fakeApi({ take: null, lines: [] });
    const user = userEvent.setup();
    const onLoaded = vi.fn();
    render(
      <BulkStockTakeDialog
        open
        onOpenChange={() => {}}
        rows={ROWS}
        categories={["Flower"]}
        api={api}
        onLoaded={onLoaded}
        onOpenCurrent={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByLabelText("What are you counting?");
    const file = new File(
      ["sku,name,counted\nGF-1,Gram Flower,27.4\nPR-1,Pre-roll,2.5\n"],
      "month-end.csv",
      { type: "text/csv" },
    );
    await user.upload(within(dialog).getByLabelText("Bulk count CSV"), file);
    const preview = await within(dialog).findByTestId("bulk-preview");
    expect(preview.textContent).toMatch(/1 counted/);
    expect(preview.textContent).toMatch(/1 problem rows/);
    expect(preview.textContent).toMatch(/Line 3 \(Pre-roll\).*whole units/);
    await user.click(
      within(dialog).getByRole("button", { name: "Start stock take and load 1 count" }),
    );
    await waitFor(() => expect(api.recordCounts).toHaveBeenCalled());
    expect(api.recordCounts.mock.calls[0]![0].lines).toEqual([{ productId: "g1", counted: 27.4 }]);
    await waitFor(() => expect(onLoaded).toHaveBeenCalled());
  });
});
