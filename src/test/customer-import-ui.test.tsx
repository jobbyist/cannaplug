// @vitest-environment happy-dom
import { vi } from "vitest";

vi.mock("@/lib/rewards.functions", () => ({
  checkUsernameFn: vi.fn().mockResolvedValue({ status: "ok" }),
  setUsernameFn: vi.fn(),
  checkReferralCodeFn: vi.fn(),
}));
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderTemplate } from "@/lib/notifications/templates";
import { verificationView } from "@/lib/verification-logic";
import { usernameProblem } from "@/lib/rewards-logic";
import { signupProblem } from "@/lib/signup-logic";
import { ReferralCard } from "@/components/account/ReferralCard";
import type { RewardsSummary } from "@/lib/rewards-data.server";

const ctx = { siteUrl: "https://cannaplug012.co.za" } as never;

describe("import invitation email", () => {
  const r = renderTemplate(
    "member_import_invite",
    { first_name: "Thandi", username: "thandi.mokoena" },
    ctx,
  )!;
  it("explains the new platform, the sign-up steps and the in-store fallback", () => {
    expect(r.subject).toMatch(/new Cannaplug is live/);
    expect(r.text).toMatch(/provisionally activated/);
    expect(r.text).toMatch(/thandi\.mokoena/);
    expect(r.text).toMatch(/Set your own password/);
    expect(r.text).toMatch(/POPIA/);
    expect(r.text).toMatch(/keep shopping in store/);
    expect(r.html).toContain("https://cannaplug012.co.za/account?mode=signup");
  });
  it("escapes what it interpolates and carries no ID or health data", () => {
    const x = renderTemplate(
      "member_import_invite",
      { first_name: "<b>x</b>", username: 'a"b' },
      ctx,
    )!;
    expect(x.html).not.toContain("<b>x</b>");
    expect(r.html + r.text).not.toMatch(/id[_ ]number|prescription|diagnos/i);
  });
});

describe("provisional approval", () => {
  it("lets the member upload an ID but not order online", () => {
    const v = verificationView({ status: "provisional" });
    expect(v.canOrder).toBe(false);
    expect(v.canSubmit).toBe(true);
    expect(v.label).toBe("Provisionally approved");
  });
});

describe("imported usernames", () => {
  it("sign-up accepts dots up to 32; choosing a new username stays strict", () => {
    expect(usernameProblem("phenyo.kgwadi", { allowImported: true })).toBeNull();
    expect(usernameProblem("mulamuleli.givenmutshotsho", { allowImported: true })).toBeNull();
    expect(usernameProblem("phenyo.kgwadi")).not.toBeNull();
    expect(
      signupProblem(
        {
          firstName: "A",
          lastName: "B",
          email: "a@b.co",
          phone: "0821234567",
          dob: "1990-01-01",
          idNumber: "AB123456",
          referral: "",
          username: "phenyo.kgwadi",
        },
        null,
      ),
    ).toBeNull();
  });
});

describe("username change card", () => {
  const base: RewardsSummary = {
    username: "thandi.mokoena",
    username_change: "available",
    username_auto: false,
    can_change: false,
    can_refer: false,
    referral_points: 1,
    referral_min_spend: 50,
    referred: [],
    points_from_referrals: 0,
    rewards: [],
  };
  it("offers one change after the ID is in, and explains the wait before that", () => {
    const { unmount } = render(
      <ReferralCard summary={base} onChanged={() => {}} origin="https://x.test" />,
    );
    expect(screen.getByTestId("username-change")).toBeTruthy();
    unmount();
    render(
      <ReferralCard
        summary={{ ...base, username_change: "needs_id" }}
        onChanged={() => {}}
        origin="https://x.test"
      />,
    );
    expect(screen.queryByTestId("username-change")).toBeNull();
    expect(screen.getByTestId("username-change-locked").textContent).toMatch(/change it once/);
  });
});
