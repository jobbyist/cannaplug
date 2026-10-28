// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, hash, children }: { to: string; hash?: string; children: unknown }) => (
    <a href={`${to}#${hash ?? ""}`}>{children as never}</a>
  ),
  createFileRoute: () => (o: unknown) => o,
}));

import { BillingLanding } from "@/components/billing/BillingLanding";

afterEach(cleanup);

describe("billing landing pages", () => {
  for (const service of ["payfast", "verifynow"] as const)
    for (const kind of ["return", "cancel", "notify"] as const)
      it(`${service} ${kind} has the logo and a Back to admin area link`, () => {
        render(<BillingLanding service={service} kind={kind} />);
        const back = screen.getByRole("link", { name: /back to admin area/i });
        expect(back.getAttribute("href")).toBe("/admin#billing");
        expect(screen.getByAltText(service === "payfast" ? "Payfast" : "VerifyNow")).toBeTruthy();
      });

  it("the return page never claims the payment was made", () => {
    render(<BillingLanding service="verifynow" kind="return" />);
    expect(screen.getByText(/nothing on this page proves it was paid/i)).toBeTruthy();
    expect(screen.queryByText(/payment (received|successful)/i)).toBeNull();
  });
});
