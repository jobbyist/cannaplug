// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin.functions", () => ({ adminSearchFn: vi.fn() }));

import { AdminSearch, toHits } from "@/components/admin/AdminSearch";
import type { AdminSearchResults } from "@/lib/admin-search.server";

const RESULTS: AdminSearchResults = {
  orders: [
    {
      id: "o1",
      order_number: "CP-2610-0007",
      contact_name: "Thandi M",
      status: "ready",
      total_rand: 300,
      delivery_method: "collection",
      created_at: "2026-10-25T10:00:00Z",
    },
  ],
  customers: [{ id: "c1", full_name: "Thandi M", phone: "082", email: "t@x.co", order_count: 1 }],
  products: [
    {
      id: "p1",
      name: "Thai Haze",
      category: "Flower",
      sku: "TH-1",
      brand: null,
      price_rand: 120,
      is_active: true,
      available: 4,
    },
  ],
  sales: [
    {
      id: "s1",
      receipt_number: "POS-261025-000001",
      status: "completed",
      total: 90,
      created_at: "2026-10-25T09:00:00Z",
    },
  ],
};
const TABS = [
  { id: "pos", label: "POS", keywords: "till refund" },
  { id: "orders", label: "Orders" },
];

afterEach(() => cleanup());

describe("admin search box", () => {
  it("groups server results with matching tabs, pickup orders flagged", () => {
    const hits = toHits("refund", TABS, RESULTS);
    expect(hits.map((h) => h.kind)).toEqual(["tab", "order", "customer", "product", "sale"]);
    expect(hits[0]).toMatchObject({ kind: "tab", id: "pos" });
    expect(hits[1]!.detail).toMatch(/pickup/);
    expect(hits[3]!.detail).toMatch(/4 available/);
  });

  it("searches after typing (debounced), and opens the highlighted result with the keyboard", async () => {
    const search = vi.fn().mockResolvedValue(RESULTS);
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<AdminSearch tabs={TABS} onOpen={onOpen} search={search} />);
    const box = screen.getByRole("combobox", { name: "Search the admin panel" });
    await user.type(box, "t");
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(search).not.toHaveBeenCalled(); // one letter is too short
    await user.type(box, "ha");
    await waitFor(() => expect(search).toHaveBeenCalledWith("tha"));
    expect(await screen.findByText("CP-2610-0007")).toBeTruthy();
    expect(screen.getByText("Till sales")).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}"); // second hit: the customer
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: "customer", id: "c1" }));
    expect((box as HTMLInputElement).value).toBe("");
  });

  it("says when nothing matches", async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ orders: [], customers: [], products: [], sales: [] });
    const user = userEvent.setup();
    render(<AdminSearch tabs={TABS} onOpen={vi.fn()} search={search} />);
    await user.type(screen.getByRole("combobox"), "zzzz");
    expect(await screen.findByText('Nothing found for "zzzz".')).toBeTruthy();
  });
});
