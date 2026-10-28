// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/admin.functions", () => ({
  saveAdminProductFn: mocks.save,
  attachProductImageFn: vi.fn(),
  createProductImageUploadFn: vi.fn(),
  removeProductImageFn: vi.fn(),
  listAdminProductsFn: vi.fn(),
  deactivateAdminProductFn: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { storage: { from: vi.fn() } } }));
vi.mock("@/components/admin/CatalogueImport", () => ({ CatalogueImport: () => null }));
vi.mock("@/components/admin/ProductCsv", () => ({ ProductCsv: () => null }));

import { ProductsPanel } from "@/components/admin/ProductsPanel";
import { ProductEditDialog } from "@/components/admin/ProductEditDialog";

const product = (over: Record<string, unknown> = {}) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "sour-og",
    name: "Sour OG",
    category: "Flower",
    subcategory: null,
    description: null,
    price_rand: 100,
    regular_price_rand: null,
    sale_ends_at: null,
    sale_online_only: false,
    unit: "g",
    strain_type: null,
    badge: null,
    sort_order: 1,
    low_stock_threshold: 5,
    is_active: true,
    sku: null,
    barcode: null,
    cost_rand: null,
    brand: null,
    sell_online: true,
    sold_by_weight: false,
    weight_step_g: 1,
    is_featured: false,
    image_url: null,
    ...over,
  }) as never;

function Harness({ list }: { list: ReturnType<typeof product>[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <ProductsPanel
      products={list}
      editingProduct={editing}
      setEditingProduct={setEditing}
      onSaved={async () => {}}
    />
  );
}

describe("product editing popup", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens in a dialog (not at the bottom of the page) and closes with Cancel", async () => {
    render(<Harness list={[product()]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit Sour OG")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("saves the sale as online only, and only while a sale price is set", async () => {
    mocks.save.mockResolvedValue({});
    render(<Harness list={[product()]} />);
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog");
    const online = within(dialog).getByLabelText(/online only/i) as HTMLInputElement;
    expect(online.disabled).toBe(true); // nothing to limit until there is a sale price
    await userEvent.type(within(dialog).getByLabelText(/^Sale price \(R/i), "80");
    expect(online.disabled).toBe(false);
    await userEvent.click(online);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(mocks.save.mock.calls[0]![0].data.input).toMatchObject({
      price_rand: 100,
      sale_price_rand: 80,
      sale_online_only: true,
    });
  });

  it("shows an online-only sale in the list and loads the box ticked", async () => {
    const p = product({ price_rand: 80, regular_price_rand: 100, sale_online_only: true });
    render(<Harness list={[p]} />);
    expect(screen.getByText("Sale · online only")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/online only/i) as HTMLInputElement).checked).toBe(true);
  });

  it("the dialog can be used on its own (Inventory)", async () => {
    render(
      <ProductEditDialog
        products={[product()]}
        editingProduct="11111111-1111-4111-8111-111111111111"
        setEditingProduct={() => {}}
        onSaved={async () => {}}
      />,
    );
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("warns about a duplicate name, then saves anyway on a second press", async () => {
    mocks.save.mockResolvedValue({});
    render(
      <ProductEditDialog
        products={[product()]}
        editingProduct="new"
        setEditingProduct={() => {}}
        onSaved={async () => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^Name/i), "sour og");
    expect(within(dialog).getByTestId("product-duplicate-warning").textContent).toMatch(/Sour OG/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(mocks.save).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  });

  it("does not warn when editing a product's price", async () => {
    render(
      <ProductEditDialog
        products={[product(), product({ id: "22222222-2222-4222-8222-222222222222" })]}
        editingProduct="11111111-1111-4111-8111-111111111111"
        setEditingProduct={() => {}}
        onSaved={async () => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByTestId("product-duplicate-warning")).toBeNull();
  });
});
