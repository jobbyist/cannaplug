import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  subscribeToMemberUpdates,
  type RealtimeChannelLike,
  type RealtimeClientLike,
} from "@/lib/member-realtime";

type Binding = { filter: Record<string, string>; callback: (p: unknown) => void };

function fakeClient() {
  const bindings: Binding[] = [];
  let statusCallback: ((s: string) => void) | undefined;
  const channel: RealtimeChannelLike = {
    on(_type, filter, callback) {
      bindings.push({ filter, callback: callback as (p: unknown) => void });
      return channel;
    },
    subscribe(cb) {
      statusCallback = cb;
      return channel;
    },
  };
  const client: RealtimeClientLike & { channelName?: string } = {
    channel(name) {
      client.channelName = name;
      return channel;
    },
    removeChannel: vi.fn(),
  };
  const emit = (table: string, row: Record<string, unknown>, event = "INSERT") => {
    for (const b of bindings.filter((x) => x.filter["table"] === table))
      b.callback({ new: row, old: null, eventType: event });
  };
  return { client, bindings, emit, status: (s: string) => statusCallback?.(s) };
}

describe("member realtime subscription", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("subscribes to the member's orders, timeline and loyalty rows on one private channel", () => {
    const { client, bindings } = fakeClient();
    subscribeToMemberUpdates(client, "user-1", () => {});
    expect(client.channelName).toBe("member-account:user-1");
    const byTable = Object.fromEntries(bindings.map((b) => [b.filter["table"]!, b.filter]));
    expect(byTable["orders"]).toMatchObject({ schema: "public", filter: "user_id=eq.user-1" });
    expect(byTable["loyalty_transactions"]).toMatchObject({
      filter: "user_id=eq.user-1",
      event: "INSERT",
    });
    expect(byTable["loyalty_accounts"]).toMatchObject({ filter: "user_id=eq.user-1" });
    // history has no user_id column: scoping is RLS's job, so no client filter is claimed.
    expect(byTable["order_status_history"]).toMatchObject({ event: "INSERT" });
    expect(byTable["order_status_history"]!["filter"]).toBeUndefined();
  });

  it("reports what changed, coalescing a burst into one callback", () => {
    const { client, emit } = fakeClient();
    const onChange = vi.fn();
    subscribeToMemberUpdates(client, "user-1", onChange, { debounceMs: 100 });
    emit("order_status_history", { id: "h1", order_id: "o1", to_status: "confirmed" });
    emit("orders", { id: "o1", user_id: "user-1", status: "confirmed" }, "UPDATE");
    emit("loyalty_transactions", { id: "t1", user_id: "user-1", points: 10 });
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect([...onChange.mock.calls[0]![0]].sort()).toEqual(["loyalty", "orders", "timeline"]);
    // A later event starts a new batch.
    emit("orders", { id: "o1", user_id: "user-1" }, "UPDATE");
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect([...onChange.mock.calls[1]![0]]).toEqual(["orders"]);
  });

  it("ignores any row that names a different member (defence in depth)", () => {
    const { client, emit } = fakeClient();
    const onChange = vi.fn();
    subscribeToMemberUpdates(client, "user-1", onChange, { debounceMs: 10 });
    emit("orders", { id: "o9", user_id: "someone-else" }, "UPDATE");
    emit("loyalty_transactions", { id: "t9", user_id: "someone-else" });
    vi.advanceTimersByTime(50);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops everything on cleanup: channel removed, pending batch dropped, late events ignored", () => {
    const { client, emit } = fakeClient();
    const onChange = vi.fn();
    const unsubscribe = subscribeToMemberUpdates(client, "user-1", onChange, { debounceMs: 100 });
    emit("orders", { id: "o1", user_id: "user-1" }, "UPDATE");
    unsubscribe();
    vi.advanceTimersByTime(500);
    emit("orders", { id: "o1", user_id: "user-1" }, "UPDATE");
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it("forwards channel status so the UI can resync after a reconnect", () => {
    const { client, status } = fakeClient();
    const onStatus = vi.fn();
    const unsubscribe = subscribeToMemberUpdates(client, "user-1", () => {}, { onStatus });
    status("SUBSCRIBED");
    status("CHANNEL_ERROR");
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(["SUBSCRIBED", "CHANNEL_ERROR"]);
    unsubscribe();
    status("CLOSED");
    expect(onStatus).toHaveBeenCalledTimes(2);
  });
});
