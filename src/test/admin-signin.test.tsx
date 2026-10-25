// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn(), resetPasswordForEmail: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { AdminSignIn, NoStaffAccess, signInMessage } from "@/components/admin/AdminSignIn";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("staff sign-in at /admin", () => {
  it("signs in with the work email and password", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<AdminSignIn />);
    await user.type(screen.getByLabelText("Work email"), " baatseba@cannaplug012.co.za ");
    await user.type(screen.getByLabelText("Password"), "Secret-123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(auth.signInWithPassword).toHaveBeenCalledWith({
        email: "baatseba@cannaplug012.co.za",
        password: "Secret-123",
      }),
    );
  });

  it("explains a wrong password without saying whether the account exists", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: new Error("Invalid login credentials") });
    const user = userEvent.setup();
    render(<AdminSignIn />);
    await user.type(screen.getByLabelText("Work email"), "x@cannaplug012.co.za");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/don't match/);
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("opens the forgot-password form", async () => {
    const user = userEvent.setup();
    render(<AdminSignIn />);
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
  });

  it("maps auth errors to plain messages", () => {
    expect(signInMessage("Email not confirmed")).toMatch(/confirmed/);
    expect(
      signInMessage("For security purposes, you can only request this after 30 seconds"),
    ).toMatch(/Too many/);
    expect(signInMessage("something odd")).toMatch(/ask a manager/);
  });

  it("tells a signed-in member they have no staff access and lets them sign out", async () => {
    const out = vi.fn();
    const user = userEvent.setup();
    render(<NoStaffAccess email="member@example.com" onSignOut={out} />);
    expect(screen.getByText("member@example.com")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Sign out/ }));
    expect(out).toHaveBeenCalled();
  });
});
