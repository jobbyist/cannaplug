// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listCustomersFn: vi.fn(),
  getAttentionCountsFn: vi.fn(),
  getMyStaffAccessFn: vi.fn(),
  getAdminOrderFn: vi.fn(),
  listAdminOrdersFn: vi.fn(),
}));
vi.mock("@/lib/admin.functions", () => api);
vi.mock("@/components/admin/reports/LiveSales", () => ({ LiveSales: () => <div>live sales</div> }));

import { ArchiveOrder } from "@/components/admin/orders/ArchiveOrder";
import { OrdersPanel } from "@/components/admin/orders/OrdersPanel";
import { CustomersPanel } from "@/components/admin/CustomersPanel";
import { OverviewPanel, SalesChart } from "@/components/admin/overview/OverviewPanel";
import { DashboardSidebar } from "@/components/dashboard/Sidebar";
import { useAttentionCounts } from "@/hooks/useAttentionCounts";
import { useStaffRoleSync } from "@/hooks/useStaffRoleSync";
import type { AdminDashboard } from "@/lib/admin-data.server";
import { LayoutDashboard } from "lucide-react";

const m = (pos: number, online: number) => ({ pos, online, total: pos + online });
const dashboard = (over: Partial<AdminDashboard["stats"]> = {}): AdminDashboard => ({
  stats: {
    revenue: { today: m(100, 50), week: m(700, 300), month: m(2000, 1000), allTime: m(9000, 4000) },
    totalSales: 321,
    paidOnline: 100,
    tillSales: 221,
    inventoryAlerts: 4,
    totalCustomers: 1234,
    ...over,
  },
  salesOverview: [
    { day: "2026-10-26", label: "Mon", pos: 10, online: 5, total: 15 },
    { day: "2026-10-27", label: "Tue", pos: 20, online: 0, total: 20 },
  ],
  topProducts: [{ name: "Blue Gelato", sold: 12, revenue: 840 }],
  recentOrders: [],
  inventory: [],
  activity: [{ label: "order status changed · order", time: "27 Oct, 10:00" }],
});

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getAttentionCountsFn.mockResolvedValue({
    orders_to_pack: 2,
    id_checks: 1,
    variances: 0,
    low_stock: 3,
    eft_waiting: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Overview tab", () => {
  it("shows revenue (till and online) and the 7-day chart to managers, with real counts", () => {
    render(
      <OverviewPanel
        dashboard={dashboard()}
        canSeeMoney
        onViewOrders={() => {}}
        onSelectOrder={() => {}}
      />,
    );
    const revenue = screen.getByLabelText("Revenue");
    for (const label of ["Today", "Last 7 days", "This month", "All time"])
      expect(within(revenue).getByText(label)).toBeTruthy();
    expect(within(revenue).getByText(/Till R\s?100/)).toBeTruthy();
    expect(screen.getByText("Sales, last 7 days")).toBeTruthy();
    expect(screen.getByLabelText("Sales for the last 7 days")).toBeTruthy();
    expect(screen.getByText("Total sales (online + till)").parentElement!.textContent).toMatch(
      /321/,
    );
    expect(screen.getByText("Members").parentElement!.textContent).toMatch(/1\s?234/);
    expect(screen.getByText(/Last 30 days, online and till together/)).toBeTruthy();
    expect(screen.getByText("Blue Gelato")).toBeTruthy();
  });

  it("keeps money away from budtenders but still shows counts and best sellers", () => {
    render(
      <OverviewPanel
        dashboard={dashboard()}
        canSeeMoney={false}
        onViewOrders={() => {}}
        onSelectOrder={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Revenue")).toBeNull();
    expect(screen.queryByText("Sales, last 7 days")).toBeNull();
    expect(screen.getByText("Low-stock products")).toBeTruthy();
    expect(screen.getByText("Blue Gelato")).toBeTruthy();
  });

  it("the chart is readable without sight and does not divide by zero on an empty week", () => {
    const { container } = render(
      <SalesChart days={[{ day: "2026-10-26", label: "Mon", pos: 0, online: 0, total: 0 }]} />,
    );
    expect(container.textContent).toMatch(/Mon: R\s?0/);
    for (const el of container.querySelectorAll<HTMLElement>("[style]"))
      expect(el.style.height).not.toMatch(/NaN|Infinity/);
  });
});

describe("Customers tab", () => {
  const rows = (n: number, start = 0) =>
    Array.from({ length: n }, (_, i) => ({
      id: `c${start + i}`,
      full_name: `Member ${start + i}`,
      phone: "0821110000",
      email: `m${start + i}@x.co`,
      member_since: "2026-10-01T10:00:00Z",
      order_count: 2,
      spend_rand: 150,
    }));

  it("loads the first page from the database and pages forward and back", async () => {
    api.listCustomersFn.mockImplementation(async ({ data }: { data: { offset: number } }) => ({
      total: 60,
      rows: rows(25, data.offset),
    }));
    const user = userEvent.setup();
    render(wrap(<CustomersPanel />));
    expect(await screen.findByText("Member 0")).toBeTruthy();
    expect(screen.getByText("Showing 1–25 of 60")).toBeTruthy();
    expect(api.listCustomersFn).toHaveBeenCalledWith({
      data: { search: null, limit: 25, offset: 0 },
    });
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Member 25")).toBeTruthy();
    expect(screen.getByText("Showing 26–50 of 60")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Previous/ }));
    expect(await screen.findByText("Showing 1–25 of 60")).toBeTruthy();
  });

  it("searches as you type (after a pause), back on page one, and says so when nothing matches", async () => {
    api.listCustomersFn.mockImplementation(async ({ data }: { data: { search: string | null } }) =>
      data.search ? { total: 0, rows: [] } : { total: 3, rows: rows(3) },
    );
    const user = userEvent.setup();
    render(wrap(<CustomersPanel />));
    await screen.findByText("Member 0");
    await user.type(screen.getByLabelText("Search customers"), "zzz");
    await waitFor(() =>
      expect(api.listCustomersFn).toHaveBeenLastCalledWith({
        data: { search: "zzz", limit: 25, offset: 0 },
      }),
    );
    expect(await screen.findByText("No customers match that search.")).toBeTruthy();
    expect(api.listCustomersFn.mock.calls.filter((c) => c[0].data.search === "z")).toHaveLength(0); // no call per key
  });

  it("starts filtered to the person chosen in the admin search box, and can show everyone again", async () => {
    api.listCustomersFn.mockResolvedValue({ total: 1, rows: rows(1) });
    const onClear = vi.fn();
    render(wrap(<CustomersPanel focusLabel="Member 0" onClearFocus={onClear} />));
    await screen.findByText("Member 0", { selector: "td" });
    expect(api.listCustomersFn.mock.calls[0]![0].data.search).toBe("Member 0");
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onClear).toHaveBeenCalled();
  });

  it("shows the server's message when loading fails", async () => {
    api.listCustomersFn.mockRejectedValue(new Error("Your role can't do this. Ask a manager."));
    render(wrap(<CustomersPanel />));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't do this/);
  });
});

describe("archiving an order", () => {
  it("is offered for unpaid and cancelled orders only, and needs a reason", async () => {
    const onArchive = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { rerender } = render(
      <ArchiveOrder
        orderNumber="CP-2610-1042"
        status="confirmed"
        archivedAt={null}
        archiveReason={null}
        onArchive={onArchive}
      />,
    );
    expect(screen.queryByRole("button", { name: /Archive order/ })).toBeNull();
    rerender(
      <ArchiveOrder
        orderNumber="CP-2610-1042"
        status="awaiting_payment"
        archivedAt={null}
        archiveReason={null}
        onArchive={onArchive}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Archive order/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/cancelled first/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Archive" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Reason/), "test order");
    await user.click(confirm);
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith(true, "test order"));
  });

  it("restores an archived order, and shows server refusals inside the dialog", async () => {
    const onArchive = vi.fn().mockRejectedValue(new Error("A paid order can't be archived"));
    const user = userEvent.setup();
    render(
      <ArchiveOrder
        orderNumber="CP-1"
        status="cancelled"
        archivedAt="2026-10-28T08:00:00Z"
        archiveReason="test order"
        onArchive={onArchive}
      />,
    );
    expect(screen.getByText(/Archived: test order/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Restore order/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/Reason/), "needed again");
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/can't be archived/);
    expect(onArchive).toHaveBeenCalledWith(false, "needed again");
  });

  it("the Orders tab offers the archive toggle and control to managers only", async () => {
    const order = {
      id: "o1",
      order_number: "CP-2610-1042",
      status: "awaiting_payment",
      customer_name: "Test",
      items: [],
      total_rand: 50,
      delivery_fee_rand: 0,
      loyalty_discount_rand: 0,
      loyalty_points_redeemed: 0,
      delivery_method: "collection",
      created_at: "2026-10-28T08:00:00Z",
      archived_at: null,
      archive_reason: null,
    } as never;
    const common = {
      orders: [order],
      selected: order,
      onSelect: () => {},
      onTransition: async () => {},
      onConfirmPayment: async () => ({ outcome: "confirmed", duplicate: false }),
    };
    const onToggle = vi.fn();
    const { unmount } = render(
      <OrdersPanel
        {...common}
        onArchive={async () => {}}
        showArchived={false}
        onToggleArchived={onToggle}
      />,
    );
    await userEvent.click(screen.getByLabelText("Show archived orders"));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: /Archive order/ })).toBeTruthy();
    unmount();
    render(<OrdersPanel {...common} />);
    expect(screen.queryByLabelText("Show archived orders")).toBeNull();
    expect(screen.queryByRole("button", { name: /Archive order/ })).toBeNull();
  });
});

describe("sidebar badges and live role", () => {
  it("shows a count on tabs that need attention, for sighted and screen reader users", () => {
    render(
      <DashboardSidebar
        items={[
          { id: "overview", icon: LayoutDashboard, label: "Overview" },
          { id: "orders", icon: LayoutDashboard, label: "Orders", badge: 3 },
          { id: "inventory", icon: LayoutDashboard, label: "Inventory", badge: 0 },
          { id: "id-checks", icon: LayoutDashboard, label: "ID Checks", badge: 120 },
        ]}
        active="overview"
        onSelect={() => {}}
        header={null}
      />,
    );
    const orders = screen.getByRole("button", { name: /Orders/ });
    expect(orders.textContent).toMatch(/3/);
    expect(within(orders).getByText("3 need attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inventory/ }).textContent).not.toMatch(/\d/);
    expect(screen.getByRole("button", { name: /ID Checks/ }).textContent).toMatch(/99\+/);
  });

  it("useAttentionCounts loads, refreshes every minute and when the signal changes, and keeps old numbers on failure", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { result, rerender } = renderHook(({ s }) => useAttentionCounts(true, s), {
      initialProps: { s: 0 },
    });
    await vi.waitFor(() => expect(result.current.counts.orders_to_pack).toBe(2));
    const calls = api.getAttentionCountsFn.mock.calls.length;
    api.getAttentionCountsFn.mockResolvedValue({
      orders_to_pack: 5,
      id_checks: 0,
      variances: 0,
      low_stock: 0,
      eft_waiting: 0,
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(api.getAttentionCountsFn.mock.calls.length).toBeGreaterThan(calls);
    expect(result.current.counts.orders_to_pack).toBe(5);
    api.getAttentionCountsFn.mockRejectedValue(new Error("offline"));
    rerender({ s: 1 });
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(result.current.counts.orders_to_pack).toBe(5);
  });

  it("useAttentionCounts does nothing for people who are not signed in as staff", () => {
    renderHook(() => useAttentionCounts(false));
    expect(api.getAttentionCountsFn).not.toHaveBeenCalled();
  });

  it("useStaffRoleSync reports a changed role within a minute, and when the tab is looked at again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const onChange = vi.fn();
    api.getMyStaffAccessFn.mockResolvedValue({ role: "budtender" });
    renderHook(() => useStaffRoleSync({ enabled: true, role: "budtender", onChange }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(onChange).not.toHaveBeenCalled(); // same role: nothing to do
    api.getMyStaffAccessFn.mockResolvedValue({ role: "manager" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(onChange).toHaveBeenCalledWith("manager");
    api.getMyStaffAccessFn.mockResolvedValue({ role: null });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("useStaffRoleSync ignores a failed check", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const onChange = vi.fn();
    api.getMyStaffAccessFn.mockRejectedValue(new Error("offline"));
    renderHook(() => useStaffRoleSync({ enabled: true, role: "manager", onChange }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(onChange).not.toHaveBeenCalled();
  });
});
