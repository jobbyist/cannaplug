// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    notices: [] as Record<string, unknown>[],
    reads: [] as Record<string, unknown>[],
    onChange: null as null | (() => void),
    onStatus: null as null | ((s: string) => void),
    removed: 0,
  };
  const from = (table: string) => ({
    select: () => ({
      order: () => ({ limit: async () => ({ data: state.notices, error: null }) }),
      limit: async () => ({
        data: table === "team_notification_reads" ? state.reads : [],
        error: null,
      }),
    }),
  });
  const channel = () => {
    const c = {
      on: (_t: string, _f: unknown, cb: () => void) => {
        state.onChange = cb;
        return c;
      },
      subscribe: (cb?: (s: string) => void) => {
        state.onStatus = cb ?? null;
        return c;
      },
    };
    return c;
  };
  return {
    state,
    supabase: { from, channel, removeChannel: () => void (state.removed += 1) },
    markTeamNoticesReadFn: vi.fn(),
    saveTeamNoticeFn: vi.fn(),
    listStaffFn: vi.fn(),
    findStaffMemberFn: vi.fn(),
    setStaffRoleFn: vi.fn(),
  };
});
vi.mock("@/integrations/supabase/client", () => ({ supabase: h.supabase }));
vi.mock("@/lib/team-notifications.functions", () => ({
  markTeamNoticesReadFn: h.markTeamNoticesReadFn,
  saveTeamNoticeFn: h.saveTeamNoticeFn,
}));
vi.mock("@/lib/staff.functions", () => ({
  listStaffFn: h.listStaffFn,
  findStaffMemberFn: h.findStaffMemberFn,
  setStaffRoleFn: h.setStaffRoleFn,
}));

import { NotificationsBell } from "@/components/admin/NotificationsBell";
import { NotificationsPanel } from "@/components/admin/NotificationsPanel";
import { StaffPanel } from "@/components/admin/StaffPanel";
import { useTeamNotifications, type TeamNotifications } from "@/hooks/useTeamNotifications";

const row = (o: Record<string, unknown> = {}) => ({
  id: "n1",
  title: "Online payments are now live!",
  body: "Members can now order online.",
  kind: "update",
  min_role: "budtender",
  status: "published",
  pinned: true,
  published_at: "2026-10-28T08:00:00Z",
  change_at: null,
  change_title: null,
  change_body: null,
  created_at: "2026-10-28T08:00:00Z",
  updated_at: "2026-10-28T08:00:00Z",
  ...o,
});

beforeEach(() => {
  h.state.notices = [row(), row({ id: "n2", title: "Draft idea", status: "draft", pinned: false })];
  h.state.reads = [];
  h.state.removed = 0;
  h.markTeamNoticesReadFn.mockResolvedValue(1);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useTeamNotifications", () => {
  it("loads notices for the signed-in staff member and counts unread published ones", async () => {
    const { result } = renderHook(() => useTeamNotifications("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.all).toHaveLength(2);
    expect(result.current.feed.map((n) => n.id)).toEqual(["n1"]); // drafts never reach the bell
    expect(result.current.unread).toBe(1);
  });

  it("marks read optimistically and tells the server", async () => {
    const { result } = renderHook(() => useTeamNotifications("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => void (await result.current.markRead(["n1"])));
    expect(result.current.unread).toBe(0);
    expect(h.markTeamNoticesReadFn).toHaveBeenCalledWith({ data: { ids: ["n1"] } });
  });

  it("re-reads when Realtime signals a change and flags the arrival", async () => {
    const { result } = renderHook(() => useTeamNotifications("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    h.state.notices = [
      row(),
      row({ id: "n3", title: "New reminder", pinned: false, updated_at: "2026-10-28T09:00:00Z" }),
    ];
    await act(async () => h.state.onChange?.());
    await waitFor(() => expect(result.current.feed.map((n) => n.id)).toContain("n3"));
    expect(result.current.fresh).toBe(1);
  });

  it("switches a notice to its scheduled replacement when the time comes, and unsubscribes on unmount", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-28T21:59:00Z"));
    h.state.notices = [
      row({
        title: "Refer-a-friend program goes live on 29 October 2026",
        change_at: "2026-10-28T22:00:00Z",
        change_title: "Refer-a-friend program is now live!",
        change_body: "Now live.",
      }),
    ];
    const { result, unmount } = renderHook(() => useTeamNotifications("u1"));
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.feed[0]!.title).toMatch(/goes live on 29 October/);
    await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
    expect(result.current.feed[0]!.title).toBe("Refer-a-friend program is now live!");
    unmount();
    expect(h.state.removed).toBe(1);
  });

  it("does nothing without a staff member", () => {
    const { result } = renderHook(() => useTeamNotifications(undefined));
    expect(result.current.feed).toEqual([]);
  });
});

describe("the bell", () => {
  const team = (over: Partial<TeamNotifications> = {}): TeamNotifications => ({
    all: [],
    feed: [
      {
        ...row(),
        switched: false,
        unread: true,
      } as unknown as TeamNotifications["feed"][number],
    ],
    unread: 1,
    loading: false,
    fresh: 0,
    markRead: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    now: Date.now(),
    ...over,
  });

  it("shows the unread count, a dropdown of updates, and the full message in a popup (marked read)", async () => {
    const t = team();
    render(<NotificationsBell team={t} />);
    const bell = screen.getByRole("button", { name: "Notifications, 1 unread" });
    await userEvent.click(bell);
    expect(t.reload).toHaveBeenCalled();
    await userEvent.click(
      await screen.findByRole("button", { name: /Online payments are now live!/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Members can now order online.")).toBeTruthy();
    expect(t.markRead).toHaveBeenCalledWith(["n1"]);
  });

  it("marks everything read and offers the manage link only when allowed", async () => {
    const t = team();
    const manage = vi.fn();
    render(<NotificationsBell team={t} onManage={manage} />);
    await userEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));
    expect(t.markRead).toHaveBeenCalledWith(["n1"]);
    await userEvent.click(screen.getByRole("button", { name: "Manage notifications" }));
    expect(manage).toHaveBeenCalled();
  });

  it("says so when there is nothing yet", async () => {
    render(<NotificationsBell team={team({ feed: [], unread: 0 })} />);
    await userEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("No updates yet.")).toBeTruthy();
  });
});

describe("Notifications tab", () => {
  const all = [
    row() as never,
    row({ id: "n2", title: "Draft idea", status: "draft", pinned: false }) as never,
  ];
  const team = (): TeamNotifications =>
    ({
      all,
      feed: [],
      unread: 0,
      loading: false,
      fresh: 0,
      markRead: vi.fn(),
      reload: vi.fn().mockResolvedValue(undefined),
      now: Date.parse("2026-10-28T10:00:00Z"),
    }) as never;

  it("publishes a notice once per submission, with South African time for a scheduled change", async () => {
    h.saveTeamNoticeFn.mockResolvedValue({ id: "x", status: "published" });
    const t = team();
    render(<NotificationsPanel team={t} role="manager" />);
    await userEvent.type(screen.getByLabelText("Title"), "Stock count tonight");
    await userEvent.type(screen.getByLabelText(/^Message/), "Please stay 15 minutes after close.");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "reminder");
    await userEvent.click(screen.getByLabelText("Replace the text automatically at a set time"));
    await userEvent.type(screen.getByLabelText(/Replace at/), "2026-10-29T00:00");
    await userEvent.type(screen.getByLabelText("New title"), "Stock count done");
    await userEvent.type(screen.getByLabelText("New message"), "Thanks all.");
    await userEvent.click(screen.getAllByRole("button", { name: "Publish" })[0]!);
    await waitFor(() => expect(h.saveTeamNoticeFn).toHaveBeenCalledTimes(1));
    const arg = h.saveTeamNoticeFn.mock.calls[0]![0].data;
    expect(arg.notice).toMatchObject({
      title: "Stock count tonight",
      kind: "reminder",
      audience: "budtender",
      status: "published",
      changeAt: "2026-10-28T22:00:00.000Z",
      changeTitle: "Stock count done",
    });
    expect(typeof arg.key).toBe("string");
    expect(t.reload).toHaveBeenCalled();
    expect((await screen.findByRole("status")).textContent).toMatch(/Published/);
  });

  it("managers cannot pick the admin-only audience; admins can", () => {
    const { unmount } = render(<NotificationsPanel team={team()} role="manager" />);
    expect(screen.queryByRole("option", { name: "Admins only" })).toBeNull();
    unmount();
    render(<NotificationsPanel team={team()} role="admin" />);
    expect(screen.getByRole("option", { name: "Admins only" })).toBeTruthy();
  });

  it("edits an existing notice, publishes a draft and archives a live one", async () => {
    h.saveTeamNoticeFn.mockResolvedValue({ id: "n2", status: "published" });
    render(<NotificationsPanel team={team()} role="admin" />);
    const draftRow = screen.getByText("Draft idea").closest("li")!;
    await userEvent.click(within(draftRow).getByRole("button", { name: /Publish/ }));
    await waitFor(() => expect(h.saveTeamNoticeFn).toHaveBeenCalled());
    expect(h.saveTeamNoticeFn.mock.calls[0]![0].data).toMatchObject({
      id: "n2",
      notice: { status: "published" },
    });
    const liveRow = screen.getByText("Online payments are now live!").closest("li")!;
    await userEvent.click(within(liveRow).getByRole("button", { name: /Archive/ }));
    await waitFor(() => expect(h.saveTeamNoticeFn).toHaveBeenCalledTimes(2));
    expect(h.saveTeamNoticeFn.mock.calls[1]![0].data).toMatchObject({
      id: "n1",
      notice: { status: "archived" },
    });
    await userEvent.click(within(liveRow).getByRole("button", { name: /Edit/ }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Online payments are now live!",
    );
  });

  it("marks automatic alerts and offers no edit or archive for them", () => {
    const auto = row({
      id: "n9",
      title: "Low stock",
      body: "3 products are at or below the low-stock level.",
      kind: "alert",
      pinned: false,
      source_key: "alert:low-stock",
    }) as never;
    const t = { ...team(), all: [auto] } as TeamNotifications;
    render(<NotificationsPanel team={t} role="admin" />);
    const li = screen.getByText("Low stock").closest("li")!;
    expect(within(li).getByText("Automatic")).toBeTruthy();
    expect(within(li).queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(within(li).queryByRole("button", { name: /Archive/ })).toBeNull();
  });

  it("shows the server's reason when saving fails", async () => {
    h.saveTeamNoticeFn.mockRejectedValue(new Error("Your role can't do this. Ask a manager."));
    render(<NotificationsPanel team={team()} role="manager" />);
    await userEvent.type(screen.getByLabelText("Title"), "Hello team");
    await userEvent.type(screen.getByLabelText(/^Message/), "Body");
    await userEvent.click(screen.getAllByRole("button", { name: "Publish" })[0]!);
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't do this/);
  });
});

describe("Staff tab", () => {
  const staff = [
    {
      user_id: "me",
      full_name: "Mia Manager",
      email: "mia@x.co",
      role: "manager",
      since: "2026-01-01T00:00:00Z",
    },
    {
      user_id: "b1",
      full_name: "Bongani Budtender",
      email: "bongani@x.co",
      role: "budtender",
      since: "2026-02-01T00:00:00Z",
    },
    {
      user_id: "m2",
      full_name: "Zola Manager",
      email: "zola@x.co",
      role: "manager",
      since: "2026-03-01T00:00:00Z",
    },
    {
      user_id: "a1",
      full_name: "Olivia Admin",
      email: "olivia@x.co",
      role: "admin",
      since: "2026-01-01T00:00:00Z",
    },
  ];
  const wrap = (ui: React.ReactNode) => (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>
  );
  beforeEach(() => {
    h.listStaffFn.mockResolvedValue(staff);
    h.setStaffRoleFn.mockResolvedValue({ changed: true, role: "manager", previous: "budtender" });
  });

  it("a manager can edit budtenders only; managers and admins show as fixed badges", async () => {
    render(wrap(<StaffPanel role="manager" myId="me" />));
    expect(await screen.findByText("Bongani Budtender")).toBeTruthy();
    expect(screen.getByLabelText("Role for Bongani Budtender")).toBeTruthy();
    expect(screen.queryByLabelText("Role for Zola Manager")).toBeNull();
    expect(screen.queryByLabelText("Role for Olivia Admin")).toBeNull();
    expect(screen.queryByLabelText("Role for Mia Manager")).toBeNull();
    const roleSelect = screen.getByLabelText("Role for Bongani Budtender");
    expect(within(roleSelect).queryByRole("option", { name: "Manager" })).toBeNull();
  });

  it("an admin can change a budtender to manager and a manager to budtender, but not admins or themselves", async () => {
    render(wrap(<StaffPanel role="admin" myId="a1" />));
    await screen.findByText("Bongani Budtender");
    expect(screen.queryByLabelText("Role for Olivia Admin")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Role for Bongani Budtender"), "manager");
    await waitFor(() => expect(h.setStaffRoleFn).toHaveBeenCalledTimes(1));
    expect(h.setStaffRoleFn.mock.calls[0]![0].data).toMatchObject({
      memberId: "b1",
      level: "manager",
    });
    expect((await screen.findByRole("status")).textContent).toMatch(
      /Bongani Budtender is now a Manager/,
    );
    expect(screen.getByLabelText("Role for Zola Manager")).toBeTruthy();
  });

  it("removes staff access only after confirming", async () => {
    render(wrap(<StaffPanel role="manager" myId="me" />));
    await screen.findByText("Bongani Budtender");
    await userEvent.click(screen.getByRole("button", { name: /Remove access/ }));
    expect(h.setStaffRoleFn).not.toHaveBeenCalled();
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove access" }),
    );
    await waitFor(() => expect(h.setStaffRoleFn).toHaveBeenCalled());
    expect(h.setStaffRoleFn.mock.calls[0]![0].data).toMatchObject({
      memberId: "b1",
      level: "none",
    });
  });

  it("finds a member by email and makes them a budtender; reports an unknown email", async () => {
    h.findStaffMemberFn.mockResolvedValueOnce({
      user_id: "c1",
      full_name: "Cara Customer",
      email: "cara@x.co",
      role: null,
    });
    h.setStaffRoleFn.mockResolvedValue({ changed: true, role: "budtender", previous: "none" });
    render(wrap(<StaffPanel role="manager" myId="me" />));
    await screen.findByText("Bongani Budtender");
    await userEvent.type(screen.getByLabelText("Member's email"), "cara@x.co");
    await userEvent.click(screen.getByRole("button", { name: /Find/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Make staff/ }));
    await waitFor(() => expect(h.setStaffRoleFn).toHaveBeenCalled());
    expect(h.setStaffRoleFn.mock.calls[0]![0].data).toMatchObject({
      memberId: "c1",
      level: "budtender",
    });
    h.findStaffMemberFn.mockResolvedValueOnce(null);
    await userEvent.type(screen.getByLabelText("Member's email"), "ghost@x.co");
    await userEvent.click(screen.getByRole("button", { name: /Find/ }));
    expect((await screen.findAllByText(/No member was found/))[0]).toBeTruthy();
  });

  it("explains why a manager cannot change another manager", async () => {
    h.findStaffMemberFn.mockResolvedValueOnce({
      user_id: "m2",
      full_name: "Zola Manager",
      email: "zola@x.co",
      role: "manager",
    });
    render(wrap(<StaffPanel role="manager" myId="me" />));
    await screen.findByText("Bongani Budtender");
    await userEvent.type(screen.getByLabelText("Member's email"), "zola@x.co");
    await userEvent.click(screen.getByRole("button", { name: /Find/ }));
    expect(await screen.findByText(/Only an admin can change a manager's role/)).toBeTruthy();
  });

  it("shows the server's refusal in plain words", async () => {
    h.setStaffRoleFn.mockRejectedValue(
      new Error("Only an admin can assign or change manager roles."),
    );
    render(wrap(<StaffPanel role="admin" myId="a1" />));
    await screen.findByText("Bongani Budtender");
    await userEvent.selectOptions(screen.getByLabelText("Role for Bongani Budtender"), "manager");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Only an admin/);
  });

  it("shows when each person last signed in, and offers a sign-up link for someone with no account", async () => {
    h.listStaffFn.mockResolvedValue([
      { ...staff[1], last_sign_in: "2026-10-27T08:00:00Z" },
      { ...staff[2], last_sign_in: null },
    ]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    h.findStaffMemberFn.mockResolvedValueOnce(null);
    render(wrap(<StaffPanel role="admin" myId="a1" />));
    expect(await screen.findByText(/Last signed in 27 Oct/)).toBeTruthy();
    expect(screen.getByText("Has not signed in yet")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Member's email"), "new@x.co");
    await userEvent.click(screen.getByRole("button", { name: /Find/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Copy sign-up link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/account`);
  });
});
