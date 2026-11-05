// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GettingStarted } from "@/components/account/GettingStarted";
import { gettingStartedSteps, tourPending } from "@/lib/tour-logic";
import { signupMetadata } from "@/lib/signup-logic";

describe("tour logic", () => {
  it("only members flagged at sign-up see it", () => {
    expect(tourPending({ user_metadata: { onboarding_tour: "pending" } })).toBe(true);
    expect(tourPending({ user_metadata: { onboarding_tour: "done" } })).toBe(false);
    expect(tourPending({ user_metadata: {} })).toBe(false);
    expect(tourPending(null)).toBe(false);
  });
  it("sign-up flags a new member", () => {
    const m = signupMetadata({
      firstName: "Rae",
      lastName: "H",
      email: "r@x.co",
      phone: "0821234567",
      dob: "1990-01-01",
      referral: "",
      username: "",
    });
    expect(m.onboarding_tour).toBe("pending");
  });
});

describe("GettingStarted checklist (replaced the popup tour, 5 Nov 2026)", () => {
  const none = { idSubmitted: false, hasUsername: false, hasAddress: false };

  it("puts the ID check first and ticks off what is done", () => {
    const steps = gettingStartedSteps(none);
    expect(steps[0]!.id).toBe("verify");
    expect(steps.every((s) => !s.done)).toBe(true);
    const later = gettingStartedSteps({ idSubmitted: true, hasUsername: true, hasAddress: false });
    expect(later.find((s) => s.id === "verify")!.done).toBe(true);
    expect(later.find((s) => s.id === "address")!.done).toBe(false);
  });

  it("is a card in the page, not a dialog, and can be hidden", async () => {
    const onGo = vi.fn();
    const onDismiss = vi.fn();
    render(<GettingStarted state={none} onGo={onGo} onDismiss={onDismiss} />);
    expect(screen.getByTestId("getting-started")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Verify now" }));
    expect(onGo).toHaveBeenCalledWith("verification");
    await userEvent.click(screen.getByRole("button", { name: "Hide getting started" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
