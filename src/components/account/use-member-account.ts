import { useCallback, useEffect, useRef, useState } from "react";
import { getMemberAccountFn } from "@/lib/member.functions";
import type { MemberAccount } from "@/lib/member-data.server";
import { subscribeToMemberUpdates, type RealtimeClientLike } from "@/lib/member-realtime";
import { supabase } from "@/integrations/supabase/client";

/**
 * Loads the member's account once, then keeps it live: Supabase Realtime (RLS-scoped) tells us when
 * an order, its timeline, or the loyalty ledger changed, and we re-read the authoritative state.
 */
export function useMemberAccount(userId: string) {
  const [data, setData] = useState<MemberAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    try {
      const next = await getMemberAccountFn();
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (alive.current)
        setError(err instanceof Error ? err.message : "Could not load your account.");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    let wasDown = false;
    const unsubscribe = subscribeToMemberUpdates(
      // supabase-js' RealtimeChannel has many overloads; RealtimeClientLike is the narrow slice we use.
      supabase as unknown as RealtimeClientLike,
      userId,
      () => void reload(),
      {
        // After a dropped connection we may have missed events, so re-read once it is back.
        onStatus: (status) => {
          if (status !== "SUBSCRIBED") wasDown = true;
          else if (wasDown) {
            wasDown = false;
            void reload();
          }
        },
      },
    );
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [userId, reload]);

  return { data, error, reload };
}

/** One idempotency key per user intent: a retried click replays; a fresh intent gets a new key. */
export function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  return {
    get: () => (ref.current ??= crypto.randomUUID()),
    reset: () => {
      ref.current = null;
    },
  };
}
