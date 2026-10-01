// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End to end in the browser layer (network mocked): the real useMemberAccount hook + the real
 * timeline component. A Realtime event for the member must re-read state and the new step must
 * appear without a page reload.
 */
const { channelCallbacks, removeChannel, getMemberAccountFn } = vi.hoisted(() => ({
  channelCallbacks: [] as ((payload: unknown) => void)[],
  removeChannel: vi.fn(),
  getMemberAccountFn: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => {
  const channel = {
    on(_t: string, filter: { table: string }, cb: (p: unknown) => void) {
      if (filter.table === "order_status_history") channelCallbacks.push(cb);
      return channel;
    },
    subscribe() {
      return channel;
    },
  };
  return { supabase: { channel: () => channel, removeChannel } };
});
vi.mock("@/lib/member.functions", () => ({
  getMemberAccountFn: (...a: unknown[]) => getMemberAccountFn(...a),
  redeemPointsFn: vi.fn(),
  reorderFn: vi.fn(),
  reorderPreviewFn: vi.fn(),
}));

import { OrderTimeline } from "@/components/account/OrdersPanel";
import { useMemberAccount } from "@/components/account/use-member-account";

const account = (statuses: string[]) => ({
  orders: [
    {
      id: "o1",
      order_number: "CP-1",
      status: statuses.at(-1),
      items: [],
      timeline: statuses.map((s, i) => ({
        id: `h${i}`,
        order_id: "o1",
        from_status: null,
        to_status: s,
        created_at: new Date(2026, 8, 30, 10, i).toISOString(),
      })),
    },
  ],
});

function Harness() {
  const { data } = useMemberAccount("user-1");
  return data ? <OrderTimeline order={data.orders[0] as never} /> : <p>loading</p>;
}

describe("order timeline updates live", () => {
  beforeEach(() => {
    channelCallbacks.length = 0;
    getMemberAccountFn.mockReset();
    removeChannel.mockReset();
  });
  afterEach(() => cleanup());

  it("shows a new status step after a Realtime event, and unsubscribes on unmount", async () => {
    getMemberAccountFn.mockResolvedValueOnce(account(["awaiting_payment"]));
    const view = render(<Harness />);
    await screen.findByText("Awaiting payment");
    expect(screen.queryByText("Confirmed")).toBeNull();

    getMemberAccountFn.mockResolvedValueOnce(account(["awaiting_payment", "confirmed"]));
    expect(channelCallbacks).toHaveLength(1);
    await act(async () => {
      channelCallbacks[0]!({ new: { id: "h1", order_id: "o1", to_status: "confirmed" } });
      await new Promise((r) => setTimeout(r, 400)); // past the 250ms coalescing window
    });
    await waitFor(() => expect(screen.getByText("Confirmed")).toBeTruthy());
    expect(screen.getByText("Awaiting payment")).toBeTruthy();
    expect(getMemberAccountFn).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });
});
