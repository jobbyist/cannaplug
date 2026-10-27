import type { User } from "@supabase/supabase-js";

/** Same person, same profile: an hourly token refresh must not look like a new sign-in. */
export function sameUser(a: User | null, b: User | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.updated_at === b.updated_at && a.email === b.email;
}
