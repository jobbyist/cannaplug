import { useCallback, useEffect, useState } from "react";
import type { AttentionCounts } from "@/lib/admin-data.server";
import { getAttentionCountsFn } from "@/lib/admin.functions";

export const NO_ATTENTION: AttentionCounts = {
  orders_to_pack: 0,
  id_checks: 0,
  variances: 0,
  low_stock: 0,
  eft_waiting: 0,
};
const REFRESH_MS = 60_000;

/**
 * What needs a person right now (for the sidebar badges). Re-read every minute, whenever the tab comes back into
 * view, and whenever `signal` changes (the team notifications changing is a good hint that something moved).
 */
export function useAttentionCounts(enabled: boolean, signal: unknown = 0) {
  const [counts, setCounts] = useState<AttentionCounts>(NO_ATTENTION);
  const load = useCallback(async () => {
    try {
      setCounts(await getAttentionCountsFn());
    } catch {
      /* badges are a convenience: keep the last numbers */
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void load();
    const every = setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(every);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, load]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, signal, load]);
  return { counts, reload: load };
}
