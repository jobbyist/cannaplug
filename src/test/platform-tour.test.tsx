// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlatformTour } from "@/components/account/PlatformTour";
import { TOUR_STEPS, tourPending } from "@/lib/tour-logic";
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
      idNumber: "1",
      referral: "",
      username: "",
    });
    expect(m.onboarding_tour).toBe("pending");
  });
});

describe("PlatformTour", () => {
  it("steps through and finishes once", async () => {
    const onFinish = vi.fn();
    const onStep = vi.fn();
    render(<PlatformTour onStep={onStep} onFinish={onFinish} />);
    expect(screen.getByText(TOUR_STEPS[0]!.title)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onStep).toHaveBeenCalledWith("verification");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    for (let i = 0; i < TOUR_STEPS.length - 1; i++)
      await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onFinish).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
  it("can be skipped at any step", async () => {
    const onFinish = vi.fn();
    render(<PlatformTour onFinish={onFinish} />);
    await userEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
