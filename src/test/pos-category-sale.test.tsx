// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin.functions", () => ({ setProductSaleFn: vi.fn() }));

import { PosSaleDialog } from "@/components/admin/pos/PosSaleDialog";
import { categoryCounts, searchCatalog, type CatalogItem } from "@/components/admin/pos/pos-logic";
import { endsAtFor, percentOff, salePriceFromPercent } from "@/lib/sale-price";

const item = (o: Partial<CatalogItem>): CatalogItem => ({
  id: o.name ?? "p",
  slug: "p",
  name: "P",
  category: "Flower",
  subcategory: null,
  strain_type: null,
  unit: null,
  price_rand: 100,
  regular_price_rand: null,
  sale_ends_at: null,
  available: 5,
  ...o,
});

afterEach(cleanup);

describe("POS category filter", () => {
  const catalog = [
    item({ name: "Thai Haze" }),
    item({ name: "Blue Dream" }),
    item({ name: "Gummies", category: "Edibles" }),
    item({ name: "Papers", category: "Accessories" }),
  ];
  it("lists categories with counts", () => {
    expect(categoryCounts(catalog)).toEqual([
      { category: "Accessories", count: 1 },
      { category: "Edibles", count: 1 },
      { category: "Flower", count: 2 },
    ]);
  });
  it("narrows search to the chosen category", () => {
    expect(searchCatalog(catalog, "", 40, "Flower").map((p) => p.name)).toEqual([
      "Thai Haze",
      "Blue Dream",
    ]);
    expect(searchCatalog(catalog, "gum", 8, "Flower")).toEqual([]);
    expect(searchCatalog(catalog, "gum", 8, null).map((p) => p.name)).toEqual(["Gummies"]);
  });
});

describe("sale prices from the till", () => {
  it("works out % off and end times", () => {
    expect(salePriceFromPercent(120, 20)).toBe(96);
    expect(salePriceFromPercent(99.99, 15)).toBe(84.99);
    expect(percentOff(120, 96)).toBe(20);
    const now = new Date(2026, 9, 27, 10, 0);
    expect(new Date(endsAtFor("today", "", now)!).getHours()).toBe(23);
    expect(new Date(endsAtFor("7d", "", now)!).getDate()).toBe(2); // 2 Nov
    expect(endsAtFor("none", "", now)).toBeNull();
  });

  it("puts a product on sale with a % and sends only the product, price and end", async () => {
    const user = userEvent.setup();
    const setSale = vi.fn(async () => ({}));
    const done = vi.fn();
    render(
      <PosSaleDialog
        product={item({ id: "p1", name: "Thai Haze", price_rand: 120 })}
        onOpenChange={() => {}}
        onDone={done}
        setSale={setSale}
      />,
    );
    await user.click(screen.getByRole("button", { name: "20%" }));
    expect(screen.getByTestId("pos-sale-preview").textContent).toMatch(/R120 → R96/);
    await user.click(screen.getByRole("button", { name: "Start sale" }));
    await waitFor(() => expect(setSale).toHaveBeenCalled());
    expect(setSale).toHaveBeenCalledWith({ productId: "p1", salePrice: 96, endsAt: null });
    expect(done.mock.calls[0]![0]).toMatch(/on sale for R96/);
  });

  it("ends a running sale", async () => {
    const user = userEvent.setup();
    const setSale = vi.fn(async () => ({}));
    render(
      <PosSaleDialog
        product={item({ id: "p2", name: "Gummies", price_rand: 80, regular_price_rand: 100 })}
        onOpenChange={() => {}}
        onDone={() => {}}
        setSale={setSale}
      />,
    );
    await user.click(screen.getByRole("button", { name: "End sale now" }));
    await waitFor(() =>
      expect(setSale).toHaveBeenCalledWith({ productId: "p2", salePrice: null, endsAt: null }),
    );
  });

  it("refuses a sale price that is not lower", async () => {
    const user = userEvent.setup();
    render(
      <PosSaleDialog
        product={item({ id: "p3", price_rand: 50 })}
        onOpenChange={() => {}}
        onDone={() => {}}
        setSale={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "Sale price" }));
    await user.type(screen.getByLabelText("Sale price (R)"), "60");
    expect(screen.getByRole("alert").textContent).toMatch(/lower than the regular price/);
    expect((screen.getByRole("button", { name: "Start sale" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
