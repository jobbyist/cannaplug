// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  getLoyaltyDeskFn: vi.fn(),
  redeemPointsRewardFn: vi.fn(),
  recordPlugBackReturnFn: vi.fn(),
  redeemPlugBackFn: vi.fn(),
  searchPosCustomersFn: vi.fn(),
}));
vi.mock("@/lib/loyalty-desk.functions", () => ({
  getLoyaltyDeskFn: fns.getLoyaltyDeskFn,
  redeemPointsRewardFn: fns.redeemPointsRewardFn,
  recordPlugBackReturnFn: fns.recordPlugBackReturnFn,
  redeemPlugBackFn: fns.redeemPlugBackFn,
}));
vi.mock("@/lib/pos.functions", () => ({ searchPosCustomersFn: fns.searchPosCustomersFn }));
vi.mock("@/components/admin/receipts/ReceiptActions", () => ({
  ReceiptActions: ({ saleId }: { saleId: string }) => (
    <div data-testid="receipt-actions">{saleId}</div>
  ),
}));
vi.mock("@/lib/admin-sync", () => ({ notifyAdminTabs: vi.fn() }));

import { LoyaltyPanel } from "@/components/admin/loyalty/LoyaltyPanel";
import { tubeProgress, tubesLine } from "@/components/admin/loyalty/loyalty-logic";
import type { LoyaltyDesk } from "@/lib/loyalty-desk.server";

const desk = (o: Partial<LoyaltyDesk> = {}, tubes = 10, points = 6): LoyaltyDesk => ({
  till: { sessionId: "11111111-1111-4111-8111-111111111111", drawerName: "Till 1" },
  points,
  rewards: [
    {
      code: "greenhouse_free",
      name: "Free Greenhouse pre-roll or bud",
      points_cost: 5,
      grade: "Greenhouse",
      products: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Blue Gelato (Greenhouse)",
          category: "Flower",
          price_rand: 50,
          unit: "g",
          available: 12,
        },
      ],
    },
    {
      code: "indoor_free",
      name: "Free Indoor pre-roll or bud",
      points_cost: 10,
      grade: "Entry Indoor",
      products: [],
    },
  ],
  plugBack: {
    tubes,
    tubes_per_reward: 10,
    rewards_available: Math.floor(tubes / 10),
    tubes_to_next: tubes >= 10 ? 0 : 10 - tubes,
    lifetime_tubes: tubes,
    rewards_given: 0,
    products: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Tube Pre-roll (Greenhouse)",
        price_rand: 60,
      },
    ],
    history: [{ kind: "return", tubes, at: "2026-10-31T08:00:00Z" }],
  },
  ...o,
});

async function pickMember() {
  fns.searchPosCustomersFn.mockResolvedValue([
    {
      id: "44444444-4444-4444-8444-444444444444",
      full_name: "Thandi M",
      phone: null,
      email: "t@x.co",
      username: "thandi",
      is_staff: false,
    },
  ]);
  const user = userEvent.setup();
  render(<LoyaltyPanel />);
  await user.type(screen.getByLabelText("Find customer"), "thandi");
  await user.click(await screen.findByRole("button", { name: /Thandi M/ }));
  await screen.findByTestId("points-balance");
  return user;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("Loyalty tab", () => {
  it("shows points, tubes and what the member can claim", async () => {
    fns.getLoyaltyDeskFn.mockResolvedValue(desk());
    await pickMember();
    expect(screen.getByTestId("points-balance").textContent).toContain("6 points");
    expect(screen.getByTestId("tube-balance").textContent).toContain("10 tubes");
    expect(screen.getByText("1 free pre-roll ready")).toBeTruthy();
    // 6 points: the 5-point reward can be redeemed, the 10-point one says how many are missing
    expect(screen.getByText("4 more points needed.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Redeem for 5 points" }) as HTMLButtonElement).disabled,
    ).toBe(true); // no product chosen yet
  });

  it("redeems points for a chosen product and shows the receipt", async () => {
    fns.getLoyaltyDeskFn.mockResolvedValue(desk());
    fns.redeemPointsRewardFn.mockResolvedValue({
      sale: { sale_id: "sale-1", receipt_number: "POS-1" },
      loyalty: {},
    });
    const user = await pickMember();
    await user.selectOptions(
      screen.getByLabelText("Product for Free Greenhouse pre-roll or bud"),
      "22222222-2222-4222-8222-222222222222",
    );
    await user.click(screen.getByRole("button", { name: "Redeem for 5 points" }));
    await waitFor(() => expect(fns.redeemPointsRewardFn).toHaveBeenCalled());
    const sent = fns.redeemPointsRewardFn.mock.calls[0]![0].data;
    expect(sent).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
      customerId: "44444444-4444-4444-8444-444444444444",
      productId: "22222222-2222-4222-8222-222222222222",
      rewardCode: "greenhouse_free",
    });
    expect(Object.keys(sent).sort()).toEqual([
      "customerId",
      "key",
      "productId",
      "rewardCode",
      "sessionId",
    ]); // ids only: no price, no points
    expect((await screen.findByTestId("receipt-actions")).textContent).toContain("sale-1");
  });

  it("gives the Plug Back free pre-roll only with 10 tubes", async () => {
    fns.getLoyaltyDeskFn.mockResolvedValue(desk({}, 9));
    const user = await pickMember();
    await user.selectOptions(
      screen.getByLabelText("Greenhouse pre-roll to give"),
      "33333333-3333-4333-8333-333333333333",
    );
    expect(
      (screen.getByRole("button", { name: "Give free pre-roll" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("1 more tube for a free pre-roll")).toBeTruthy();
  });

  it("gives the free pre-roll with 10 tubes and reloads the balance", async () => {
    fns.getLoyaltyDeskFn.mockResolvedValueOnce(desk({}, 10)).mockResolvedValue(desk({}, 0));
    fns.redeemPlugBackFn.mockResolvedValue({
      sale_id: "sale-2",
      receipt_number: "POS-2",
      tubes_spent: 10,
      tubes: 0,
    });
    const user = await pickMember();
    await user.selectOptions(
      screen.getByLabelText("Greenhouse pre-roll to give"),
      "33333333-3333-4333-8333-333333333333",
    );
    await user.click(screen.getByRole("button", { name: "Give free pre-roll" }));
    expect(await screen.findByText(/Free Greenhouse pre-roll given for 10 tubes/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("tube-balance").textContent).toContain("0 tubes"),
    );
  });

  it("records returned tubes", async () => {
    fns.getLoyaltyDeskFn.mockResolvedValue(desk({}, 3));
    fns.recordPlugBackReturnFn.mockResolvedValue({ customer_id: "c", recorded: 4, tubes: 7 });
    const user = await pickMember();
    await user.type(screen.getByLabelText("Tubes brought back"), "4");
    await user.click(screen.getByRole("button", { name: "Record tubes" }));
    await waitFor(() => expect(fns.recordPlugBackReturnFn).toHaveBeenCalled());
    expect(fns.recordPlugBackReturnFn.mock.calls[0]![0].data).toMatchObject({
      customerId: "44444444-4444-4444-8444-444444444444",
      tubes: 4,
    });
    expect(await screen.findByText("4 tubes recorded.")).toBeTruthy();
  });

  it("asks staff to open their till first, and blocks rewards until then", async () => {
    fns.getLoyaltyDeskFn.mockResolvedValue(desk({ till: null }));
    const user = await pickMember();
    expect(screen.getByRole("note").textContent).toContain("Open your till");
    await user.selectOptions(
      screen.getByLabelText("Greenhouse pre-roll to give"),
      "33333333-3333-4333-8333-333333333333",
    );
    expect(
      (screen.getByRole("button", { name: "Give free pre-roll" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows a plain error and keeps the key for a safe retry when a reward fails", async () => {
    fns.getLoyaltyDeskFn.mockResolvedValue(desk());
    fns.redeemPlugBackFn
      .mockRejectedValueOnce(new Error("Not enough stock available"))
      .mockResolvedValue({ sale_id: "s", receipt_number: "POS-3", tubes_spent: 10, tubes: 0 });
    const user = await pickMember();
    await user.selectOptions(
      screen.getByLabelText("Greenhouse pre-roll to give"),
      "33333333-3333-4333-8333-333333333333",
    );
    await user.click(screen.getByRole("button", { name: "Give free pre-roll" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Not enough stock available");
    await user.click(screen.getByRole("button", { name: "Give free pre-roll" }));
    await waitFor(() => expect(fns.redeemPlugBackFn).toHaveBeenCalledTimes(2));
    const [a, b] = fns.redeemPlugBackFn.mock.calls.map((c) => c[0].data.key);
    expect(a).toBe(b); // same intended action, same idempotency key
  });
});

describe("Loyalty helpers", () => {
  it("measures progress towards the next free pre-roll", () => {
    expect(tubeProgress(0, 10)).toBe(0);
    expect(tubeProgress(4, 10)).toBe(40);
    expect(tubeProgress(10, 10)).toBe(100);
    expect(tubeProgress(13, 10)).toBe(30);
    expect(tubeProgress(5, 0)).toBe(0);
    expect(tubesLine(3, 10)).toBe("7 more tubes for a free pre-roll");
    expect(tubesLine(25, 10)).toBe("2 free pre-rolls ready");
  });
});
