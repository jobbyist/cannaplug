// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ updateUser: vi.fn(), resetPasswordForEmail: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));

import {
  ChangePasswordForm,
  ForgotPasswordForm,
  passwordProblem,
} from "@/components/account/PasswordForms";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("password rules", () => {
  it("needs 8+ characters, letters and a number, and a matching repeat", () => {
    expect(passwordProblem("short1", "short1")).toMatch(/8 characters/);
    expect(passwordProblem("onlyletters", "onlyletters")).toMatch(/number/);
    expect(passwordProblem("abcdefg1", "abcdefg2")).toMatch(/do not match/);
    expect(passwordProblem("Canna-new-2026", "Canna-new-2026")).toBeNull();
  });
});

describe("ChangePasswordForm", () => {
  it("changes the signed-in user's password and confirms it", async () => {
    auth.updateUser.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(<ChangePasswordForm />);
    await user.type(screen.getByLabelText("New password"), "Canna-new-2026");
    await user.type(screen.getByLabelText("Repeat new password"), "Canna-new-2026");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(auth.updateUser).toHaveBeenCalledWith({ password: "Canna-new-2026" }),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/Password changed/);
  });

  it("refuses a weak password before calling the server, and explains a leaked one", async () => {
    const user = userEvent.setup();
    render(<ChangePasswordForm />);
    await user.type(screen.getByLabelText("New password"), "abc");
    await user.type(screen.getByLabelText("Repeat new password"), "abc");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/8 characters/);
    expect(auth.updateUser).not.toHaveBeenCalled();
    auth.updateUser.mockResolvedValue({
      error: new Error("Password is known to be weak and easy to guess"),
    });
    await user.clear(screen.getByLabelText("New password"));
    await user.clear(screen.getByLabelText("Repeat new password"));
    await user.type(screen.getByLabelText("New password"), "password123");
    await user.type(screen.getByLabelText("Repeat new password"), "password123");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/data leak/));
  });
});

describe("ForgotPasswordForm", () => {
  it("emails a reset link back to /account and never says whether the account exists", async () => {
    auth.resetPasswordForEmail.mockRejectedValue(new Error("User not found"));
    const user = userEvent.setup();
    render(<ForgotPasswordForm onBack={vi.fn()} />);
    await user.type(screen.getByLabelText("Email address"), "someone@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() =>
      expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("someone@example.com", {
        redirectTo: "https://cannaplug012.co.za/account?reset=1",
      }),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /If that email has a CannaPlug account/,
    );
  });
});

describe("email sending problems", () => {
  it("tells the customer when the reset email could not be sent (rate limit), without revealing the account", async () => {
    auth.resetPasswordForEmail.mockResolvedValue({
      data: null,
      error: new Error("email rate limit exceeded"),
    });
    const user = userEvent.setup();
    render(<ForgotPasswordForm onBack={vi.fn()} />);
    await user.type(screen.getByLabelText("Email address"), "someone@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't send the email/);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
