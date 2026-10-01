/**
 * Supabase Realtime wiring for the member account.
 *
 * The browser only ever receives rows the database's RLS lets the signed-in member read (own orders,
 * own timeline, own loyalty rows — see the Milestone 4 migration). This module therefore does not
 * "filter for security"; the `user_id` filters and the payload guard below only cut noise and act as
 * defence in depth. Events are used purely as a signal: the UI re-reads authoritative state, so a
 * dropped or duplicated event can never leave the screen wrong for long.
 */

export type MemberChangeKind = "orders" | "timeline" | "loyalty" | "verification";

type Payload = { new?: Record<string, unknown> | null; old?: Record<string, unknown> | null };

export type RealtimeChannelLike = {
  on(
    type: "postgres_changes",
    filter: { event: string; schema: string; table: string; filter?: string },
    callback: (payload: Payload) => void,
  ): RealtimeChannelLike;
  subscribe(callback?: (status: string) => void): RealtimeChannelLike;
};

export type RealtimeClientLike = {
  channel(name: string): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): unknown;
};

export type MemberSubscriptionOptions = {
  /** Coalesces bursts (a status change writes several rows) into one callback. */
  debounceMs?: number;
  /** Fires on every channel status change, e.g. to refetch after a reconnect. */
  onStatus?: (status: string) => void;
};

export function subscribeToMemberUpdates(
  client: RealtimeClientLike,
  userId: string,
  onChange: (kinds: ReadonlySet<MemberChangeKind>) => void,
  options: MemberSubscriptionOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 250;
  let pending = new Set<MemberChangeKind>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const flush = () => {
    timer = null;
    if (closed || pending.size === 0) return;
    const kinds = pending;
    pending = new Set();
    onChange(kinds);
  };

  const signal = (kind: MemberChangeKind) => (payload: Payload) => {
    if (closed) return;
    // Defence in depth: never react to a row that names a different member.
    const owner = payload.new?.["user_id"] ?? payload.old?.["user_id"];
    if (typeof owner === "string" && owner !== userId) return;
    pending.add(kind);
    if (timer === null) timer = setTimeout(flush, debounceMs);
  };

  const channel = client
    .channel(`member-account:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "orders", filter: `user_id=eq.${userId}` },
      signal("orders"),
    )
    // order_status_history has no user_id column; RLS (own orders only) is what scopes it.
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "order_status_history" },
      signal("timeline"),
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "loyalty_transactions",
        filter: `user_id=eq.${userId}`,
      },
      signal("loyalty"),
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "loyalty_accounts",
        filter: `user_id=eq.${userId}`,
      },
      signal("loyalty"),
    )
    // An ID decision (approved / rejected) should show up without a refresh.
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "customer_verification",
        filter: `user_id=eq.${userId}`,
      },
      signal("verification"),
    )
    .subscribe((status) => {
      if (!closed) options.onStatus?.(status);
    });

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = new Set();
    void client.removeChannel(channel);
  };
}
