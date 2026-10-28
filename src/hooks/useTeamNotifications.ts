import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { markTeamNoticesReadFn } from "@/lib/team-notifications.functions";
import {
  effectiveNotice,
  isUnread,
  nextChangeAt,
  sortNotices,
  type TeamNotice,
} from "@/lib/team-notifications";

const REFRESH_MS = 5 * 60_000;
const MAX_TIMEOUT = 2_000_000_000;

/**
 * The team's notices, live. They are read straight from the database as the signed-in staff member (RLS decides
 * what they may see) and kept current with Supabase Realtime. Events are only a signal to re-read, so a dropped
 * one is caught by the reconnect refresh, the 5-minute refresh, or the next time the bell opens.
 */
export function useTeamNotifications(userId: string | undefined) {
  const [all, setAll] = useState<TeamNotice[]>([]);
  const [reads, setReads] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(0);
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const [n, r] = await Promise.all([
      supabase
        .from("team_notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100),
      supabase.from("team_notification_reads").select("notification_id,read_at").limit(500),
    ]);
    if (n.error || r.error) {
      setLoading(false);
      return;
    }
    const rows = (n.data ?? []) as unknown as TeamNotice[];
    setAll(rows);
    setReads(Object.fromEntries((r.data ?? []).map((x) => [x.notification_id, x.read_at])));
    setNow(Date.now());
    setLoading(false);
    // Count notices that arrive after the first load, for the bell's attention pulse.
    const published = rows
      .filter((x) => x.status === "published")
      .map((x) => `${x.id}@${x.updated_at}`);
    if (seen.current) {
      const added = published.filter((k) => !seen.current!.has(k)).length;
      if (added) setFresh((f) => f + added);
    }
    seen.current = new Set(published);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    };
    const channel = supabase
      .channel(`team-notifications-${userId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_notifications" }, soon)
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") soon();
      });
    const every = setInterval(() => void load(), REFRESH_MS);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(every);
      void supabase.removeChannel(channel);
    };
  }, [userId, load]);

  // When a scheduled replacement is due, switch the text right then without waiting for a refresh.
  useEffect(() => {
    const at = nextChangeAt(all, now);
    if (!at) return;
    const wait = Math.min(Math.max(at - Date.now() + 500, 0), MAX_TIMEOUT);
    const id = setTimeout(() => {
      setNow(Date.now());
      void load();
    }, wait);
    return () => clearTimeout(id);
  }, [all, now, load]);

  const feed = useMemo(
    () =>
      sortNotices(all.filter((n) => n.status === "published")).map((n) => ({
        ...effectiveNotice(n, now),
        unread: isUnread(n, reads[n.id], now),
      })),
    [all, reads, now],
  );
  const unread = feed.filter((n) => n.unread).length;

  const markRead = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const stamp = new Date().toISOString();
      setReads((r) => ({ ...r, ...Object.fromEntries(ids.map((id) => [id, stamp])) }));
      try {
        await markTeamNoticesReadFn({ data: { ids } });
      } catch {
        void load(); // the server did not take it: show the true state again
      }
    },
    [load],
  );

  return { all, feed, unread, loading, fresh, markRead, reload: load, now };
}

export type TeamNotifications = ReturnType<typeof useTeamNotifications>;
