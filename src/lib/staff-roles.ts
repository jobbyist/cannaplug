import type { StaffRole } from "@/lib/admin-nav";

/**
 * Who may change whose role. The database enforces the same rules in staff_set_role; this only decides which
 * buttons the screen offers.
 *  - A manager can add, change and remove budtenders.
 *  - An admin can also add, change and remove managers.
 *  - Admin roles are not changed here, and nobody changes their own role.
 */
export type StaffMember = {
  user_id: string;
  full_name: string | null;
  email: string;
  role: StaffRole;
  since: string;
  /** When they last signed in (null if never). */
  last_sign_in?: string | null;
};

/** The roles `actor` may hand out. */
export const assignableRoles = (actor: StaffRole | null): ("budtender" | "manager")[] =>
  actor === "admin" ? ["budtender", "manager"] : actor === "manager" ? ["budtender"] : [];

/** `current` is the person's staff role now, or null when they have none. */
export function canEditRole(
  actor: StaffRole | null,
  actorId: string,
  target: { user_id: string; role: StaffRole | null },
): boolean {
  if (!actor || target.user_id === actorId) return false;
  if (target.role === "admin") return false;
  if (actor === "admin") return true;
  return actor === "manager" && (target.role === null || target.role === "budtender");
}

export const displayName = (m: { full_name: string | null; email: string }) =>
  m.full_name?.trim() || m.email;
