// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for a bug the LIVE browser run found: after a refused reorder the dialog refreshed to the
 * new price but its refresh cleared the "prices changed" explanation, so the numbers changed silently.
 */
const mocks = vi.hoisted(() => ({
  reorderPreviewFn: vi.fn(),
  reorderFn: vi.fn(),
  redeemPointsFn: vi.fn(),
}));
vi.mock("@/lib/member.functions", () => mocks);

import { OrdersPanel } from "@/components/account/OrdersPanel";

const check = (price: number, total: number) => ({
  order_id: "o1",
  order_number: "CP-1",
  orderable: true,
  delivery_fee: 0,
  current_total: total,
  lines: [
    {
      product_id: "p1",
      name: "Blue Gelato",
      quantity: 2,
      previous_price: 100,
      current_price: price,
      available: 10,
      status: price === 100 ? "ok" : "price_changed",
    },
  ],
});

const account = {
  orders: [
    {
      id: "o1",
      order_number: "CP-1",
      status: "completed",
      created_at: new Date().toISOString(),
      total_rand: 200,
      delivery_fee_rand: 0,
      loyalty_discount_rand: 0,
      loyalty_points_redeemed: 0,
      items: [{ id: "i1", product_name: "Blue Gelato", quantity: 2, unit_price_rand: 100 }],
      timeline: [],
    },
  ],
  loyalty: {
    balance: 0,
    rules: {
      minRedeemPoints: 100,
      maxRedeemPct: 50,
      redeemRandPerPoint: 0.1,
      earnRandPerPoint: 10,
    },
  },
} as never;

describe("reorder dialog", () => {
  beforeEach(() => Object.values(mocks).forEach((m) => m.mockReset()));
  afterEach(() => cleanup());

  it("keeps the explanation visible when a refused reorder refreshes to the new price", async () => {
    const user = userEvent.setup();
    mocks.reorderPreviewFn
      .mockResolvedValueOnce(check(100, 200))
      .mockResolvedValue(check(120, 240));
    mocks.reorderFn.mockRejectedValueOnce(
      new Error(
        "Prices changed while you were reviewing — please check the new total (the current total is R240)",
      ),
    );
    render(<OrdersPanel account={account} reload={async () => {}} notify={() => {}} />);
    await user.click(screen.getByRole("button", { name: /reorder/i }));
    await user.click(await screen.findByRole("button", { name: /place order/i }));

    // fresh numbers…
    await screen.findByText("Total R240");
    // …and the reason they changed
    expect(
      (await screen.findByText(/Prices changed while you were reviewing/)).textContent,
    ).toContain("R240");
    expect(mocks.reorderPreviewFn).toHaveBeenCalledTimes(2);
  });
});
