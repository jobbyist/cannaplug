// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  saveAdminProductFn: vi.fn(),
  deactivateAdminProductFn: vi.fn(),
  deleteAdminProductFn: vi.fn(),
  restoreAdminProductFn: vi.fn(),
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

  it("budtenders see the list but no editing, import or CSV controls", () => {
    render(
      <ProductsPanel
        products={[product] as never}
        editingProduct={product.id}
        setEditingProduct={vi.fn()}
        onSaved={vi.fn()}
        canEdit={false}
      />,
    );
    expect(screen.getAllByText("TS-WR").length).toBeGreaterThan(0);
    for (const name of [/^Edit$/, /Deactivate/, /Add product/, /Import from Yoco/, /CSV upload/])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByTestId("product-editor")).toBeNull();
  });

  describe("delete", () => {
    const panel = (products: unknown[], onSaved = vi.fn().mockResolvedValue(undefined)) => {
      render(
        <ProductsPanel
          products={products as never}
          editingProduct={null}
          setEditingProduct={vi.fn()}
          onSaved={onSaved}
        />,
      );
      return onSaved;
    };

    it("asks first, then deletes and says so; only the id and a key are sent", async () => {
      fns.deleteAdminProductFn.mockResolvedValue({
        mode: "deleted",
        product_id: product.id,
        name: product.name,
        sku: product.sku,
      });
      const onSaved = panel([product]);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: `Delete ${product.name}` }));
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getAllByText(/archived/).length).toBeGreaterThan(0);
      expect(fns.deleteAdminProductFn).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole("button", { name: "Delete product" }));
      await waitFor(() => expect(fns.deleteAdminProductFn).toHaveBeenCalled());
      const sent = fns.deleteAdminProductFn.mock.calls[0]![0].data;
      expect(Object.keys(sent).sort()).toEqual(["key", "productId"]);
      expect(sent.productId).toBe(product.id);
      expect(await screen.findByText(`${product.name} was deleted.`)).toBeTruthy();
      expect(onSaved).toHaveBeenCalled();
    });

    it("explains when a product with history was archived instead", async () => {
      fns.deleteAdminProductFn.mockResolvedValue({
        mode: "archived",
        product_id: product.id,
        name: product.name,
        sku: product.sku,
      });
      panel([product]);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: `Delete ${product.name}` }));
      await user.click(
        within(await screen.findByRole("alertdialog")).getByRole("button", {
          name: "Delete product",
        }),
      );
      expect(
        await screen.findByText(/has sales or stock history, so it was archived/),
      ).toBeTruthy();
    });

    it("archived products are hidden until 'Show archived', and can be restored", async () => {
      fns.restoreAdminProductFn.mockResolvedValue({ product_id: "a1", name: "Old Haze" });
      const archived = {
        ...product,
        id: "aaaaaaaa-2222-4333-8444-555555555555",
        name: "Old Haze",
        sku: "OLD-1",
        is_active: false,
        archived_at: "2026-11-08T08:00:00Z",
      };
      panel([product, archived]);
      expect(screen.queryByText("Old Haze")).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByLabelText(/Show archived \(1\)/));
      expect(screen.getByText("Old Haze")).toBeTruthy();
      expect(screen.getByText("Archived")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Restore" }));
      await waitFor(() => expect(fns.restoreAdminProductFn).toHaveBeenCalled());
      expect(fns.restoreAdminProductFn.mock.calls[0]![0].data.productId).toBe(archived.id);
      expect(await screen.findByText("Old Haze was restored and is active again.")).toBeTruthy();
    });

    it("budtenders get no delete button", () => {
      render(
        <ProductsPanel
          products={[product] as never}
          editingProduct={null}
          setEditingProduct={vi.fn()}
          onSaved={vi.fn()}
          canEdit={false}
        />,
      );
      expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    });
  });
});
