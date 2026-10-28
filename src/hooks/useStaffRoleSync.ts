import { useEffect, useRef } from "react";
import { getMyStaffAccessFn } from "@/lib/admin.functions";
import type { StaffRole } from "@/lib/admin-nav";

const CHECK_MS = 60_000;

/**
 * Keeps the open admin page in step with the person's real role. The server checks the role on every action, so a
 * change always takes effect there at once; this makes the screen follow (new tabs appear, lost access shows
 * the "no access" page) within a minute, or as soon as the tab is looked at again, without a reload.
 */
export function useStaffRoleSync({
  enabled,
  role,
  onChange,
}: {
  enabled: boolean;
  role: StaffRole | null;
  onChange: (next: StaffRole | null) => void;
}) {
  const current = useRef(role);
  current.current = role;
  const notify = useRef(onChange);
  notify.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = async () => {
      try {
        const { role: next } = await getMyStaffAccessFn();
        if (alive && next !== current.current) notify.current(next);
      } catch {
        /* a failed check keeps what is on screen; the next one tries again */
      }
    };
    const every = setInterval(() => void check(), CHECK_MS);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive = false;
      clearInterval(every);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled]);
}
