// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ searchPosCustomersFn: vi.fn() }));
vi.mock("@/lib/pos.functions", () => server);

import { CustomerPicker } from "@/components/admin/pos/CustomerPicker";
import { verificationView } from "@/lib/verification-logic";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("staff skip the online ID check", () => {
  it("a staff account can order and is not asked to verify, whatever its ID status", () => {
    for (const status of ["unverified", "pending", "rejected", "expired"]) {
      const v = verificationView({ status, staff_exempt: true });
      expect(v.canOrder).toBe(true);
      expect(v.canSubmit).toBe(false);
      expect(v.label).toBe("Staff");
      expect(v.status).toBe("verified"); // so the dashboard banner stays hidden
    }
  });
  it("a member is unchanged", () => {
    expect(verificationView({ status: "unverified" }).canOrder).toBe(false);
    expect(verificationView({ status: "pending" }).canOrder).toBe(false);
    expect(verificationView({ status: "verified" }).canOrder).toBe(true);
    expect(verificationView(null).canOrder).toBe(false);
  });
});

describe("till customer picker: who can be attached", () => {
  const hits = [
    {
      id: "peer",
      full_name: "Peer Budtender",
      phone: null,
      email: null,
      is_staff: true,
      can_attach: true,
      blocked_reason: null,
    },
    {
      id: "me",
      full_name: "Me Myself",
      phone: null,
      email: null,
      is_staff: true,
      can_attach: false,
      blocked_reason: "You cannot give yourself the staff rate on your own till sale",
    },
    {
      id: "boss",
      full_name: "Big Boss",
      phone: null,
      email: null,
      is_staff: true,
      can_attach: false,
      blocked_reason: "Only a manager or admin can attach this staff member",
    },
    {
      id: "m",
      full_name: "Plain Member",
      phone: null,
      email: null,
      is_staff: false,
      can_attach: true,
      blocked_reason: null,
    },
  ];
  const open = async () => {
    server.searchPosCustomersFn.mockResolvedValue(hits);
    const onChange = vi.fn();
    render(<CustomerPicker value={null} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("Find customer"), "bo");
    await screen.findByText("Peer Budtender");
    return onChange;
  };

  it("disables a staff member the person cannot attach and says why", async () => {
    await open();
    const me = screen.getByRole("button", { name: /Me Myself/ }) as HTMLButtonElement;
    const boss = screen.getByRole("button", { name: /Big Boss/ }) as HTMLButtonElement;
    expect(me.disabled).toBe(true);
    expect(boss.disabled).toBe(true);
    expect(screen.getByText(/cannot give yourself the staff rate/)).toBeTruthy();
    expect(screen.getByText(/Only a manager or admin can attach/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Peer Budtender/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: /Plain Member/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("attaches an allowed staff member (flagged staff) and ignores clicks on a blocked one", async () => {
    const onChange = await open();
    await userEvent.click(screen.getByRole("button", { name: /Me Myself/ }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Peer Budtender/ }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ id: "peer", name: "Peer Budtender", staff: true }),
    );
  });
});
