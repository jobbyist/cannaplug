// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let listener: ((event: string, session: unknown) => void) | null = null;
  return {
    emit: (event: string, session: unknown) => listener?.(event, session),
    auth: {
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        listener = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      getSession: vi.fn(async () => ({ data: { session: null } })),
      exchangeCodeForSession: vi.fn(async () => ({ error: null })),
      updateUser: vi.fn(async () => ({ error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    },
    getMyStaffAccessFn: vi.fn(async () => ({ role: null as string | null })),
  };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: mocks.auth } }));
vi.mock("@/lib/admin.functions", () => ({ getMyStaffAccessFn: mocks.getMyStaffAccessFn }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: unknown) => opts,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { safeRedirect, signInHref } from "@/lib/safe-redirect";
import { RESET_REDIRECT, recoveryLinkProblem } from "@/lib/auth-messages";
import { ageGateNeeded } from "@/components/age-gate-logic";
import { passwordChecks } from "@/lib/password-rules";
import { ResetPasswordPage } from "@/routes/reset-password";

describe("redirect after sign-in", () => {
  it("accepts only paths on this site", () => {
    expect(safeRedirect("/checkout")).toBe("/checkout");
    expect(safeRedirect("/journal/some-post?x=1")).toBe("/journal/some-post?x=1");
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "/javascript:alert(1)",
      "checkout",
      "",
      "/account",
      "/account?mode=signup",
      "/reset-password",
      `/${"a".repeat(400)}`,
      "/ok\nnext",
      null,
      42,
    ])
      expect(safeRedirect(bad), String(bad)).toBeNull();
  });

  it("builds sign-in links that come back afterwards", () => {
    expect(signInHref("/checkout")).toBe("/account?redirect=%2Fcheckout");
    expect(signInHref("/rewards", "signup")).toBe("/account?mode=signup&redirect=%2Frewards");
    expect(signInHref("https://evil.example")).toBe("/account");
  });
});

describe("reset link problems", () => {
  it("explains an expired or used link, in the hash or the query", () => {
    expect(
      recoveryLinkProblem("#error=access_denied&error_code=otp_expired&error_description=x", ""),
    ).toMatch(/expired or has already been used/);
    expect(recoveryLinkProblem("", "?error=server_error")).toMatch(/didn't work/);
    expect(recoveryLinkProblem("#access_token=abc&type=recovery", "")).toBeNull();
  });

  it("reset emails land on the reset page of the live site", () => {
    expect(RESET_REDIRECT).toBe("https://cannaplug012.co.za/reset-password");
  });

  it("the reset page is never behind the 18+ question", () => {
    expect(ageGateNeeded("/reset-password", "Mozilla", null, Date.now())).toBe(false);
    expect(ageGateNeeded("/account", "Mozilla", null, Date.now())).toBe(true);
  });

  it("the same password rules show as a live checklist", () => {
    expect(passwordChecks("abc").every((c) => !c.ok)).toBe(true);
    expect(passwordChecks("abcdefg1").every((c) => c.ok)).toBe(true);
  });
});

describe("/reset-password page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/reset-password");
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("an expired link says so and offers a new one, without waiting", async () => {
    window.history.replaceState(
      null,
      "",
      "/reset-password#error=access_denied&error_code=otp_expired",
    );
    render(<ResetPasswordPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/expired/);
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
  });

  it("asks for a new password once Supabase signs the person in from the link, then sends staff to admin", async () => {
    window.history.replaceState(null, "", "/reset-password#access_token=t&type=recovery");
    mocks.getMyStaffAccessFn.mockResolvedValueOnce({ role: "manager" });
    const user = userEvent.setup();
    render(<ResetPasswordPage />);
    act(() => mocks.emit("PASSWORD_RECOVERY", { user: { id: "u1" } }));
    await user.type(await screen.findByLabelText("New password"), "Canna-new-2026");
    await user.type(screen.getByLabelText("Repeat new password"), "Canna-new-2026");
    await user.click(screen.getByRole("button", { name: "Choose a new password" }));
    await waitFor(() =>
      expect(mocks.auth.updateUser).toHaveBeenCalledWith({ password: "Canna-new-2026" }),
    );
    const go = await screen.findByRole("link", { name: "Go to staff admin" });
    expect(go.getAttribute("href")).toBe("/admin");
    // The token is gone from the address bar.
    expect(window.location.hash).toBe("");
  });

  it("members go back to their account", async () => {
    mocks.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: "u2" } } },
    } as never);
    const user = userEvent.setup();
    render(<ResetPasswordPage />);
    await user.type(await screen.findByLabelText("New password"), "Canna-new-2026");
    await user.type(screen.getByLabelText("Repeat new password"), "Canna-new-2026");
    await user.click(screen.getByRole("button", { name: "Choose a new password" }));
    const go = await screen.findByRole("link", { name: "Go to my account" });
    expect(go.getAttribute("href")).toBe("/account");
  });

  it("with no link at all, it stops waiting and offers to send one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ResetPasswordPage />);
    expect(screen.getByRole("status").textContent).toMatch(/Checking/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/couldn't find a reset link/);
  });

  it("the password field can be shown, so a suggested password is never lost", async () => {
    mocks.auth.getSession.mockResolvedValueOnce({
      data: { session: { user: { id: "u3" } } },
    } as never);
    const user = userEvent.setup();
    render(<ResetPasswordPage />);
    const input = (await screen.findByLabelText("New password")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("new-password");
    await user.click(screen.getAllByRole("button", { name: "Show password" })[0]!);
    expect(input.type).toBe("text");
  });
});
