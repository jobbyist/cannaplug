// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ overview: vi.fn() }));
vi.mock("@/lib/payments.functions", () => ({
  approveEftFn: vi.fn(),
  getPaymentsOverviewFn: mocks.overview,
  rejectEftFn: vi.fn(),
  setManualFxRateFn: vi.fn(),
  updateFxSettingsFn: vi.fn(),
}));
vi.mock("@/components/admin/EftDetailsCard", () => ({ EftDetailsCard: () => null }));
vi.mock("@/components/admin/PayfastAccountCard", () => ({
  PayfastAccountCard: () => <div data-testid="payfast-account" />,
}));

import { PaymentsPanel } from "@/components/admin/PaymentsPanel";

const overview = (card: boolean) => ({
  configured: { card, paypal: false },
  eft: { bank: "x" },
  settings: { fxMarginPercent: 4, fxMode: "live", eftDualControlThreshold: 10000 },
  fx: null,
  transactions: [],
  rejectionsLast24h: 0,
});

describe("Payments tab", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("no longer shows the PayFast pending notice, and lists what PayFast accepts", async () => {
    mocks.overview.mockResolvedValue(overview(true));
    render(<PaymentsPanel />);
    await screen.findByText("Providers");
    expect(screen.queryByText(/pending activation/i)).toBeNull();
    const list = screen.getByLabelText("PayFast payment options");
    expect(Array.from(list.querySelectorAll("li")).map((l) => l.textContent)).toEqual([
      "Card",
      "Instant EFT",
      "Apple Pay",
      "Google Pay",
    ]);
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByTestId("payfast-account")).toBeTruthy();
  });
});
