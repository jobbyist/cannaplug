// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/payments.functions", () => ({
  approveEftFn: vi.fn(),
  getPaymentsOverviewFn: vi.fn(),
  rejectEftFn: vi.fn(),
  setManualFxRateFn: vi.fn(),
  updateFxSettingsFn: vi.fn(),
}));
vi.mock("@/components/admin/EftDetailsCard", () => ({ EftDetailsCard: () => null }));

import { PayfastPendingNotice } from "@/components/admin/PaymentsPanel";

describe("Payments tab", () => {
  it("says PayFast is pending activation, word for word", () => {
    render(<PayfastPendingNotice />);
    expect(screen.getByRole("status").textContent).toBe(
      "Payfast payment pending activation, contact your administrator or developer for details",
    );
  });
});
