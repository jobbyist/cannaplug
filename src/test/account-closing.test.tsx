// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  getMyAccountStateFn: vi.fn(),
  setMyAccountStatusFn: vi.fn(),
  deleteMemberAccountFn: vi.fn(),
}));
vi.mock("@/lib/account-lifecycle.functions", () => fns);

import { AccountClosingCard, AccountStatusBanner } from "@/components/account/AccountClosing";
import { useAccountLifecycle } from "@/hooks/useAccountLifecycle";
import { DeleteAccountDialog } from "@/components/admin/DeleteAccountDialog";
import { closeBlockedReason, reasonProblem, statusLabel } from "@/lib/account-lifecycle";

const state = (o: Record<string, unknown> = {}) => ({
  status: "active",
  deactivated_at: null,
  deletion_requested_at: null,
  open_orders: 0,
  ...o,
});

function Harness() {
  const life = useAccountLifecycle();
  return (
    <>
      <AccountStatusBanner life={life} />
      <AccountClosingCard life={life} />
    </>
  );
}

beforeEach(() => {
  Object.values(fns).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe("account lifecycle wording and rules", () => {
  it("blocks closing while an order is open, and says how many", () => {
    expect(closeBlockedReason({ open_orders: 0 })).toBeNull();
    expect(closeBlockedReason({ open_orders: 1 })).toMatch(/1 open order\./);
    expect(closeBlockedReason({ open_orders: 2 })).toMatch(/2 open orders/);
  });
  it("labels each status and checks the admin reason like the database does", () => {
    expect(statusLabel("deletion_requested")).toBe("Deletion requested");
    expect(statusLabel("deactivated")).toBe("Deactivated");
    expect(reasonProblem("ab")).not.toBeNull();
    expect(reasonProblem("asked by WhatsApp")).toBeNull();
    expect(reasonProblem("x".repeat(201))).not.toBeNull();
  });
});

describe("member account closing card", () => {
  it("deactivates only after the member confirms, then shows the banner and a reactivate button", async () => {
    fns.getMyAccountStateFn.mockResolvedValue(state());
    fns.setMyAccountStatusFn.mockResolvedValue(state({ status: "deactivated" }));
    render(<Harness />);
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate my account" }));
    expect(fns.setMyAccountStatusFn).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() =>
      expect(fns.setMyAccountStatusFn).toHaveBeenCalledWith({
        data: { action: "deactivate", key: expect.any(String) },
      }),
    );
    expect(
      await screen.findByText(/Your account is deactivated\. You can't place orders/),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reactivate account" }).length).toBe(2);
  });

  it("deletion needs the word DELETE", async () => {
    fns.getMyAccountStateFn.mockResolvedValue(state());
    fns.setMyAccountStatusFn.mockResolvedValue(state({ status: "deletion_requested" }));
    render(<Harness />);
    await userEvent.click(await screen.findByRole("button", { name: "Request deletion" }));
    const confirm = screen.getAllByRole("button", { name: "Request deletion" }).at(-1)!;
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "delete");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(fns.setMyAccountStatusFn).toHaveBeenCalledWith({
        data: { action: "request_deletion", key: expect.any(String) },
      }),
    );
    expect(await screen.findByText(/You asked us to delete your account/)).toBeTruthy();
  });

  it("disables both choices while an order is open", async () => {
    fns.getMyAccountStateFn.mockResolvedValue(state({ open_orders: 1 }));
    render(<Harness />);
    expect(await screen.findByText(/1 open order/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Deactivate my account" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Request deletion" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows the database's message when the action is refused", async () => {
    fns.getMyAccountStateFn.mockResolvedValue(state());
    fns.setMyAccountStatusFn.mockRejectedValue(
      new Error("Please finish or cancel your open orders."),
    );
    render(<Harness />);
    await userEvent.click(await screen.findByRole("button", { name: "Deactivate my account" }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Please finish or cancel your open orders.",
    );
  });
});

describe("admin delete dialog", () => {
  const member = { id: "11111111-1111-4111-8111-111111111111", name: "Katlego", requested: false };
  it("needs a reason and the word DELETE, then deletes once", async () => {
    fns.deleteMemberAccountFn.mockResolvedValue({
      deleted: true,
      kept: { orders: 2, medical_documents: 0 },
      warnings: [],
    });
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    render(<DeleteAccountDialog member={member} onClose={onClose} onDeleted={onDeleted} />);
    const del = screen.getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Reason"), "asked by WhatsApp");
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    expect(del.disabled).toBe(false);
    await userEvent.click(del);
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(fns.deleteMemberAccountFn).toHaveBeenCalledTimes(1);
    expect(fns.deleteMemberAccountFn).toHaveBeenCalledWith({
      data: { memberId: member.id, reason: "asked by WhatsApp", key: expect.any(String) },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("lists follow-ups when storage or sign-in cleanup did not finish", async () => {
    fns.deleteMemberAccountFn.mockResolvedValue({
      deleted: true,
      kept: { orders: 0, medical_documents: 0 },
      warnings: ["The ID photos could not be removed from storage. Remove them by hand."],
    });
    render(
      <DeleteAccountDialog
        member={{ ...member, requested: true }}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Delete account" }));
    expect(await screen.findByText(/ID photos could not be removed/)).toBeTruthy();
  });
});
