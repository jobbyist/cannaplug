/**
 * Team notifications: pure helpers shared by the bell, the Notifications tab and the tests.
 * A notice may carry a scheduled replacement (change_at); once that time has passed, the replacement is what
 * everyone sees, and the notice counts as unread again for people who read the earlier text.
 */
export type NoticeKind = "update" | "reminder" | "alert";
export type NoticeStatus = "draft" | "published" | "archived";
export type NoticeAudience = "budtender" | "manager" | "admin";

export type TeamNotice = {
  id: string;
  title: string;
  body: string;
  kind: NoticeKind;
  min_role: NoticeAudience;
  status: NoticeStatus;
  pinned: boolean;
  published_at: string | null;
  change_at: string | null;
  change_title: string | null;
  change_body: string | null;
  /** Set on automatic alerts (they update themselves from live counts). */
  source_key?: string | null;
  created_at: string;
  updated_at: string;
};

export const KIND_LABEL: Record<NoticeKind, string> = {
  update: "Update",
  reminder: "Reminder",
  alert: "Important",
};

const t = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

export const changeApplied = (n: TeamNotice, now: number) =>
  !!n.change_at && !!n.change_title && !!n.change_body && t(n.change_at) <= now;

/** What people see right now (the scheduled replacement once its time has come). */
export function effectiveNotice(n: TeamNotice, now: number): TeamNotice & { switched: boolean } {
  return changeApplied(n, now)
    ? { ...n, title: n.change_title!, body: n.change_body!, switched: true }
    : { ...n, switched: false };
}

/** The moment the text last changed for readers: an edit, or the scheduled replacement taking over. */
export const lastChangeAt = (n: TeamNotice, now: number) =>
  Math.max(t(n.updated_at) || 0, changeApplied(n, now) ? t(n.change_at) : 0);

export const isUnread = (n: TeamNotice, readAt: string | undefined, now: number) =>
  !readAt || t(readAt) < lastChangeAt(n, now);

/** Pinned first, then newest. */
export function sortNotices<T extends TeamNotice>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      (t(b.published_at ?? b.created_at) || 0) - (t(a.published_at ?? a.created_at) || 0),
  );
}

/** The next future replacement time, so the screen can refresh itself when it arrives. */
export function nextChangeAt(list: TeamNotice[], now: number): number | null {
  const future = list
    .filter(
      (n) => n.status === "published" && n.change_at && n.change_title && t(n.change_at) > now,
    )
    .map((n) => t(n.change_at));
  return future.length ? Math.min(...future) : null;
}

/** South Africa has no daylight saving, so SAST is always UTC+2. */
export const sastToIso = (local: string) => new Date(`${local}:00+02:00`).toISOString();
export const isoToSastInput = (iso: string) =>
  new Date(Date.parse(iso) + 2 * 3600_000).toISOString().slice(0, 16);
export const formatSast = (iso: string) =>
  new Date(iso).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
