// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({
  listCustomersFn: vi.fn(),
  setCustomerUsernameFn: vi.fn(),
  checkUsernameFn: vi.fn(),
}));
vi.mock("@/lib/admin.functions", () => ({
  listCustomersFn: api.listCustomersFn,
  setCustomerUsernameFn: api.setCustomerUsernameFn,
}));
vi.mock("@/lib/rewards.functions", () => ({ checkUsernameFn: api.checkUsernameFn }));

import { CustomersPanel } from "@/components/admin/CustomersPanel";

const rows = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    full_name: "Thandi Nkosi",
    phone: "0821110001",
    email: "t@x.co",
    username: "thandin",
    member_since: "2026-10-01T10:00:00Z",
    order_count: 2,
    spend_rand: 300,
  },
];

const mount = (canEditUsername: boolean) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CustomersPanel canEditUsername={canEditUsername} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.listCustomersFn.mockResolvedValue({ total: 1, rows });
  api.checkUsernameFn.mockResolvedValue({ status: "ok" });
  api.setCustomerUsernameFn.mockResolvedValue({ username: "thandi_n", previous: "thandin" });
});
afterEach(() => cleanup());

describe("Customers tab: change a member's username", () => {
  it("shows each member's username, and the Change button only to managers and admins", async () => {
    mount(true);
    expect(await screen.findByText("thandin")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Change username for Thandi Nkosi/ })).toBeTruthy();
    cleanup();
    mount(false);
    expect(await screen.findByText("thandin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Change username for/ })).toBeNull();
  });

  it("needs a free username and a reason before it saves, then sends the member, name, reason and a key", async () => {
    const user = userEvent.setup();
    mount(true);
    await user.click(await screen.findByRole("button", { name: /Change username for/ }));
    const save = screen.getByRole("button", { name: "Change username" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.clear(screen.getByLabelText("New username"));
    await user.type(screen.getByLabelText("New username"), "Thandi_N");
    await waitFor(() =>
      expect(screen.getByTestId("admin-username-status").textContent).toMatch(/Available/),
    );
    expect(save.disabled).toBe(true); // still no reason
    await user.type(screen.getByLabelText("Reason"), "Member asked for it");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(api.setCustomerUsernameFn).toHaveBeenCalled());
    const sent = api.setCustomerUsernameFn.mock.calls[0]![0].data;
    expect(sent).toMatchObject({
      memberId: rows[0]!.id,
      username: "thandi_n",
      reason: "Member asked for it",
    });
    expect(String(sent.key).length).toBeGreaterThanOrEqual(8);
  });

  it("does not let a taken username through", async () => {
    api.checkUsernameFn.mockResolvedValue({ status: "taken" });
    const user = userEvent.setup();
    mount(true);
    await user.click(await screen.findByRole("button", { name: /Change username for/ }));
    await user.clear(screen.getByLabelText("New username"));
    await user.type(screen.getByLabelText("New username"), "someone");
    await user.type(screen.getByLabelText("Reason"), "Member asked for it");
    await waitFor(() =>
      expect(screen.getByTestId("admin-username-status").textContent).toMatch(/taken/),
    );
    expect(
      (screen.getByRole("button", { name: "Change username" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
