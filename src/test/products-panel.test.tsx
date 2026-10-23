// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  saveAdminProductFn: vi.fn(),
  deactivateAdminProductFn: vi.fn(),
  createProductImageUploadFn: vi.fn(),
  attachProductImageFn: vi.fn(),
  removeProductImageFn: vi.fn(),
  listAdminProductsFn: vi.fn(),
}));
vi.mock("@/lib/admin.functions", () => fns);
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ uploadToSignedUrl: vi.fn() }) } },
}));

import { ProductsPanel } from "@/components/admin/ProductsPanel";

const product = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "white-runtz",
  name: "White Runtz (Top Shelf)",
  category: "Flower",
  subcategory: null,
  description: null,
  price_rand: 120,
  unit: "g",
  strain_type: null,
  badge: null,
  sort_order: 100,
  is_active: true,
  created_at: "2026-10-23T00:00:00Z",
  sku: "TS-WR",
  barcode: null,
  cost_rand: 60,
  image_path: null,
  image_url: null,
};

afterEach(cleanup);

describe("ProductsPanel", () => {
  it("shows SKU in the list and saves SKU, barcode and cost from labelled fields", async () => {
    fns.saveAdminProductFn.mockResolvedValue({});
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const setEditing = vi.fn();
    render(
      <ProductsPanel
        products={[product] as never}
        editingProduct={product.id}
        setEditingProduct={setEditing}
        onSaved={onSaved}
      />,
    );
    expect(screen.getAllByText("TS-WR").length).toBeGreaterThan(0);
    const user = userEvent.setup();
    const barcode = screen.getByLabelText("Barcode");
    await user.type(barcode, "6001234567890");
    const cost = screen.getByLabelText(/Cost price/);
    await user.clear(cost);
    await user.type(cost, "65");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fns.saveAdminProductFn).toHaveBeenCalled());
    const sent = fns.saveAdminProductFn.mock.calls[0]![0].data;
    expect(sent.productId).toBe(product.id);
    expect(sent.input).toMatchObject({ sku: "TS-WR", barcode: "6001234567890", cost_rand: 65 });
    expect(Object.keys(sent.input)).not.toContain("image_path");
  });

  it("asks to save a new product before adding a photo, and surfaces save errors", async () => {
    fns.saveAdminProductFn.mockRejectedValue(
      new Error("That SKU is already used by another product."),
    );
    render(
      <ProductsPanel
        products={[product] as never}
        editingProduct="new"
        setEditingProduct={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText(/Save the product first/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "That SKU is already used by another product.",
    );
  });
});
