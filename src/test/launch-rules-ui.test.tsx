// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  listPurchaseLimitsFn: vi.fn(),
  setPurchaseLimitFn: vi.fn(),
  resetVerificationAttemptsFn: vi.fn(),
}));
vi.mock("@/lib/launch-rules.functions", () => fns);

import { PurchaseLimitsCard } from "@/components/admin/PurchaseLimitsCard";

const limits = (canEdit: boolean) => ({
  canEdit,
  limits: [
    { category: "Flower", daily_max: null, enabled: false, updated_at: null },
    { category: "Edibles", daily_max: 10, enabled: true, updated_at: "2026-10-25T10:00:00Z" },
  ],
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PurchaseLimitsCard", () => {
  it("an admin switches a category on with a number; only category, number, on/off and a key are sent", async () => {
    fns.listPurchaseLimitsFn.mockResolvedValue(limits(true));
    fns.setPurchaseLimitFn.mockResolvedValue({});
    const user = userEvent.setup();
    render(<PurchaseLimitsCard />);
    const input = await screen.findByLabelText("Flower limit per day");
    await user.type(input, "30");
    await user.click(screen.getAllByRole("button", { name: "Switch on" })[0]!);
    await waitFor(() => expect(fns.setPurchaseLimitFn).toHaveBeenCalled());
    const sent = fns.setPurchaseLimitFn.mock.calls[0]![0].data;
    expect(Object.keys(sent).sort()).toEqual(["category", "dailyMax", "enabled", "key"]);
    expect(sent).toMatchObject({ category: "Flower", dailyMax: 30, enabled: true });
  });

  it("managers see the limits but cannot change them", async () => {
    fns.listPurchaseLimitsFn.mockResolvedValue(limits(false));
    render(<PurchaseLimitsCard />);
    expect(await screen.findByText("Only an admin can change these limits.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Switch/ })).toBeNull();
    expect(screen.getByText("10")).toBeTruthy();
  });
});
