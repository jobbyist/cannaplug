// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const setUsername = vi.hoisted(() => vi.fn().mockResolvedValue({ username: "thandi" }));
vi.mock("@/lib/rewards.functions", () => ({
  checkUsernameFn: vi.fn().mockResolvedValue({ status: "available" }),
  setUsernameFn: setUsername,
  checkReferralCodeFn: vi.fn(),
}));

import { ReferralCard } from "@/components/account/ReferralCard";
import type { RewardsSummary } from "@/lib/rewards-data.server";

const base: RewardsSummary = {
  username: "thandi",
  username_change: "none",
  username_auto: false,
  can_change: false,
  can_refer: true,
  referral_points: 1,
  referral_min_spend: 50,
  referred: [],
  points_from_referrals: 0,
  rewards: [],
};
afterEach(() => cleanup());

describe("ReferralCard", () => {
  it("shows the member's code and link when they can refer", () => {
    render(<ReferralCard summary={base} onChanged={() => {}} origin="https://x.test" />);
    expect(screen.getByText("thandi")).toBeTruthy();
    expect(screen.getByText("https://x.test/account?ref=thandi")).toBeTruthy();
    expect(screen.getByText(/1 loyalty point for every friend/)).toBeTruthy();
  });

  it("asks for a username when none is set, and shows no code or link", () => {
    render(
      <ReferralCard
        summary={{ ...base, username: null, can_refer: false }}
        onChanged={() => {}}
        origin="https://x.test"
      />,
    );
    expect(screen.queryByText("https://x.test/account?ref=thandi")).toBeNull();
    expect(screen.getAllByText(/username/i).length).toBeGreaterThan(0);
  });

  it("tells a member without a verified ID that their code is not active yet", () => {
    render(
      <ReferralCard
        summary={{ ...base, can_refer: false }}
        onChanged={() => {}}
        origin="https://x.test"
      />,
    );
    expect(screen.getAllByText(/verif/i).length).toBeGreaterThan(0);
  });

  it("offers a generated username once: keep it or change it", async () => {
    const onChanged = vi.fn();
    render(
      <ReferralCard
        summary={{ ...base, username_auto: true, can_change: true }}
        onChanged={onChanged}
        origin="https://x.test"
      />,
    );
    expect(screen.getByTestId("username-change").textContent).toMatch(/generated the username/);
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(setUsername).toHaveBeenCalled());
    expect(setUsername.mock.calls[0]![0].data.username).toBe("thandi");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("does not offer a change once the username is final", () => {
    render(<ReferralCard summary={base} onChanged={() => {}} origin="https://x.test" />);
    expect(screen.queryByTestId("username-change")).toBeNull();
  });
});
