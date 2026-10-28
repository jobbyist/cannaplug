// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cart", () => ({
  useCart: () => ({ add: vi.fn() }),
  rand: (n: number | string) => `R${Number(n).toFixed(2)}`,
}));
vi.mock("@/lib/admin.functions", () => ({ listStoreProductsFn: vi.fn() }));

import { ShopView } from "@/components/shop/ShopView";
import type { StoreProduct } from "@/components/shop/ProductCard";
import type { ShopSearch } from "@/lib/shop-filter";

let n = 0;
const prod = (o: Partial<StoreProduct> & { name: string; category: string }): StoreProduct =>
  ({
    id: `p${++n}`,
    slug: `p${n}`,
    subcategory: null,
    strain_type: null,
    description: null,
    price_rand: 100,
    regular_price_rand: null,
    unit: "g",
    badge: null,
    is_active: true,
    sort_order: 100,
    image_path: null,
    image_url: null,
    sold_by_weight: false,
    in_stock: true,
    ...o,
  }) as StoreProduct;

const PRODUCTS = [
  prod({
    name: "Astro Grape (Outdoor)",
    category: "Flower",
    subcategory: "Outdoor",
    price_rand: 24,
  }),
  prod({
    name: "Jealousy (Greenhouse)",
    category: "Flower",
    subcategory: "Greenhouse",
    price_rand: 50,
    strain_type: "Indica",
  }),
  prod({
    name: "Zaza (Top Shelf)",
    category: "Flower",
    subcategory: "Top Shelf",
    price_rand: 120,
    strain_type: "Hybrid",
  }),
  prod({
    name: "Apple Strudel (Premium Indoor)",
    category: "Flower",
    subcategory: "Premium Indoor",
    price_rand: 100,
    in_stock: false,
  }),
  prod({
    name: "Runtz Stick (Top Shelf)",
    category: "Pre-rolls",
    subcategory: "Top Shelf",
    price_rand: 120,
  }),
  prod({ name: "Gummy Bears", category: "Edibles", price_rand: 60 }),
];

/** Stands in for the route: the search lives in state the way it lives in the address bar. */
function Harness({
  initial = {},
  spy,
  products = PRODUCTS,
  loading = false,
  error = false,
}: {
  initial?: ShopSearch;
  spy?: (s: ShopSearch) => void;
  products?: StoreProduct[];
  loading?: boolean;
  error?: boolean;
}) {
  const [search, setSearch] = useState<ShopSearch>(initial);
  return (
    <ShopView
      products={products}
      loading={loading}
      error={error}
      onRetry={() => spy?.({ category: "retry" })}
      search={search}
      onSearch={(s) => {
        spy?.(s);
        setSearch(s);
      }}
    />
  );
}
const cards = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
const cats = () => screen.getByRole("navigation", { name: "Categories" });

afterEach(cleanup);

describe("ShopView", () => {
  it("shows every product, with counts on the category pills", () => {
    render(<Harness />);
    expect(cards()).toHaveLength(6);
    expect(screen.getByText("Showing 6 of 6 products")).toBeTruthy();
    expect(within(cats()).getByRole("button", { name: /Flower\s*4/ })).toBeTruthy();
    expect(within(cats()).getByRole("button", { name: /Pre-rolls\s*1/ })).toBeTruthy();
  });

  it("choosing a category filters, and the other categories keep their counts", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.click(within(cats()).getByRole("button", { name: /Pre-rolls/ }));
    expect(cards()).toEqual(["Runtz Stick (Top Shelf)"]);
    expect(spy).toHaveBeenLastCalledWith({ category: "Pre-rolls" });
    expect(within(cats()).getByRole("button", { name: /Flower\s*4/ })).toBeTruthy();
  });

  it("a category in any case from the address bar is understood", () => {
    render(<Harness initial={{ category: "flower" }} />);
    expect(cards()).toHaveLength(4);
    expect(
      within(cats())
        .getByRole("button", { name: /Flower/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("subcategory chips appear for a category, in grade order, and filter", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ category: "Flower" }} />);
    const sub = screen.getByRole("navigation", { name: "Flower types" });
    expect(
      within(sub)
        .getAllByRole("button")
        .map((b) => b.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["All Flower", "Outdoor 1", "Greenhouse 1", "Premium Indoor 1", "Top Shelf 1"]);
    await user.click(within(sub).getByRole("button", { name: /Top Shelf/ }));
    expect(cards()).toEqual(["Zaza (Top Shelf)"]);
    await user.click(within(sub).getByRole("button", { name: /All Flower/ }));
    expect(cards()).toHaveLength(4);
  });

  it("there are no subcategory chips for a category without any", () => {
    render(<Harness initial={{ category: "Edibles" }} />);
    expect(screen.queryByRole("navigation", { name: /types/ })).toBeNull();
  });

  it("changing category drops the subcategory", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ category: "Flower", sub: "Top Shelf" }} />);
    expect(cards()).toEqual(["Zaza (Top Shelf)"]);
    await user.click(within(cats()).getByRole("button", { name: /Pre-rolls/ }));
    expect(cards()).toEqual(["Runtz Stick (Top Shelf)"]);
    expect(screen.queryByRole("button", { name: /Remove filter Top Shelf/ })).toBeNull();
  });

  it("the in-stock filter works and the placeholder is gone", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByText(/coming next/i)).toBeNull();
    await user.click(screen.getAllByLabelText(/In stock only/)[0]!);
    expect(cards()).not.toContain("Apple Strudel (Premium Indoor)");
    expect(screen.getByText("Showing 5 of 6 products")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove filter In stock" })).toBeTruthy();
  });

  it("an out-of-stock product says so", () => {
    render(<Harness />);
    expect(screen.getAllByText("Out of stock")).toHaveLength(1);
  });

  it("search narrows the results after a short pause and can be cleared with the chip", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await user.type(screen.getByLabelText("Search products"), "gummy");
    expect(spy).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(spy).toHaveBeenLastCalledWith({ q: "gummy" });
    expect(cards()).toEqual(["Gummy Bears"]);
    await user.click(screen.getByRole("button", { name: /Remove filter/ }));
    expect(cards()).toHaveLength(6);
    vi.useRealTimers();
  });

  it("strain is only offered when products have strains, and filters", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness initial={{ strain: "Hybrid" }} />);
    expect(cards()).toEqual(["Zaza (Top Shelf)"]);
    await user.click(screen.getByRole("button", { name: "Remove filter Hybrid" }));
    expect(cards()).toHaveLength(6);
    unmount();
    render(<Harness products={[PRODUCTS[5]!]} />);
    expect(screen.queryByText("Strain type")).toBeNull();
  });

  it("an empty result says so and offers to clear", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ category: "Edibles", sale: true }} />);
    expect(screen.getByText("No products match your filters.")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: /Clear filters/ })[0]!);
    expect(cards()).toHaveLength(6);
  });

  it("a failed load shows an error and a retry; loading shows placeholders, not an empty message", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const { unmount } = render(<Harness products={[]} error spy={spy} />);
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't be loaded/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(spy).toHaveBeenCalled();
    unmount();
    render(<Harness products={[]} loading />);
    expect(screen.queryByText(/No products match/)).toBeNull();
    expect(screen.getByText("Loading the menu…")).toBeTruthy();
  });

  it("sorting by price puts the cheapest first", async () => {
    render(<Harness initial={{ sort: "price-asc" }} />);
    expect(cards()[0]).toBe("Astro Grape (Outdoor)");
  });
});

describe("price slider", () => {
  it("has a handle at each end of the range, so a maximum can be set as well as a minimum", () => {
    render(<Harness />);
    const thumbs = screen.getAllByRole("slider");
    // the desktop panel is always in the page: its range slider has both a Minimum and a Maximum handle
    expect(thumbs.map((t) => t.getAttribute("aria-label"))).toEqual(["Minimum", "Maximum"]);
    expect(thumbs[0]!.getAttribute("aria-valuenow")).toBe("24");
    expect(thumbs[1]!.getAttribute("aria-valuenow")).toBe("120");
  });
});
