import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSalesReportFn } from "@/lib/sales-report.functions";
import type { SalesReport } from "@/lib/sales-report-logic";
import { useAdminTabSync } from "@/lib/admin-sync";

export type ReportLoader = (from: string, to: string) => Promise<SalesReport>;
const serverLoader: ReportLoader = (from, to) =>
  getSalesReportFn({ data: { from, to } }) as Promise<SalesReport>;

/**
 * Loads a sales report and keeps it live: it reloads the moment a till sale or an online order changes
 * (Supabase realtime, for every signed-in staff member on any device), when another admin tab reports a
 * change, and every `pollMs` as a fallback. Reloads are quiet: the last numbers stay on screen meanwhile.
 */
export function useSalesReport(
  from: string,
  to: string,
  {
    live = true,
    pollMs = 30_000,
    load = serverLoader,
  }: { live?: boolean; pollMs?: number; load?: ReportLoader } = {},
) {
  const [report, setReport] = useState<SalesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await load(from, to);
      if (mine !== seq.current) return;
      setReport(r);
      setError(null);
      setUpdatedAt(new Date());
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : "Could not load sales.");
    }
  }, [from, to, load]);

  useEffect(() => {
    setReport(null);
    void refresh();
  }, [refresh]);

  useAdminTabSync(["stock", "orders", "payments"], () => void refresh(), 300);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void refresh();
    }, pollMs);
    let pending: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void refresh(), 500);
    };
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel(`admin-sales-${Math.random().toString(36).slice(2)}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "pos_sales" }, soon)
        .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, soon)
        .subscribe((status) => setConnected(status === "SUBSCRIBED"));
    } catch {
      channel = null;
    }
    return () => {
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [live, pollMs, refresh]);

  return { report, error, updatedAt, connected, refresh };
}
