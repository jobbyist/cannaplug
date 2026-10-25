// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  exportProductsCsvFn: vi.fn(),
  previewProductCsvFn: vi.fn(),
  commitProductCsvFn: vi.fn(),
}));
vi.mock("@/lib/product-csv.functions", () => fns);

import { ProductCsv } from "@/components/admin/ProductCsv";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const file = () => new File(["sku,price\nFL-001,130\n"], "edited.csv", { type: "text/csv" });

describe("ProductCsv dialog", () => {
  it("previews changes and saves only after Confirm, sending the file and a key (never prices it computed)", async () => {
    fns.previewProductCsvFn.mockResolvedValue({
      creates: [],
      updates: [
        {
          line: 2,
          sku: "FL-001",
          name: "Candyland",
          changes: [{ field: "price", from: "120.00", to: "130.00" }],
        },
      ],
      unchanged: 4,
      issues: [],
      notes: [],
    });
    fns.commitProductCsvFn.mockResolvedValue({
      rows: 1,
      created: 0,
      updated: 1,
      unchanged: 0,
      stocked_products: 0,
      opening_units: 0,
      sales_ended: 0,
    });
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ProductCsv onSaved={onSaved} />);
    await user.click(screen.getByRole("button", { name: /CSV upload/ }));
    expect(screen.getByRole("button", { name: /Blank template/ })).toBeTruthy();
    await user.upload(screen.getByLabelText("Product CSV"), file());
    await screen.findByTestId("product-csv-preview");
    expect(screen.getByText("130.00")).toBeTruthy();
    expect(fns.commitProductCsvFn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save 1 product" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const sent = fns.commitProductCsvFn.mock.calls[0]![0].data;
    expect(Object.keys(sent).sort()).toEqual(["csv", "key"]);
    expect(sent.csv).toContain("FL-001,130");
    expect(screen.getByRole("status").textContent).toMatch(/0 created · 1 updated/);
  });

  it("blocks saving while the file has problem rows", async () => {
    fns.previewProductCsvFn.mockResolvedValue({
      creates: [],
      updates: [],
      unchanged: 0,
      issues: [{ line: 3, sku: "X-1", problem: 'Unknown category "Weed"' }],
      notes: [],
    });
    const user = userEvent.setup();
    render(<ProductCsv onSaved={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /CSV upload/ }));
    await user.upload(screen.getByLabelText("Product CSV"), file());
    await screen.findByText(/Line 3 \(X-1\): Unknown category/);
    expect(
      (screen.getByRole("button", { name: /Save 0 products/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
