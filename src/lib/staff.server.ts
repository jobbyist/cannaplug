import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import type { StaffMember } from "@/lib/staff-roles";

/** Plain sentences for the rule messages staff_set_role raises (the generic mapper would hide them). */
export function friendlyStaffRoleError(err: unknown): Error {
  const raw =
    err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
  if (/cannot change your own role/i.test(raw)) return new Error("You can't change your own role.");
  if (/admin roles are managed/i.test(raw))
    return new Error("Admin roles are managed by the owner and can't be changed here.");
  if (/only an admin can assign or change manager/i.test(raw))
    return new Error("Only an admin can assign or change manager roles.");
  if (/^member_not_found/i.test(raw)) return new Error("No member was found with that email.");
  if (/^invalid_input/i.test(raw)) return new Error("Enter a full email address.");
  return err instanceof Error ? err : new Error(raw);
}

type FoundMember = {
  user_id: string;
  full_name: string | null;
  email: string;
  role: StaffMember["role"] | null;
};

export async function listStaff(userId: string): Promise<StaffMember[]> {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("staff_directory", { p_actor: userId });
  if (error) throw friendlyStaffRoleError(error);
  return (data ?? []) as unknown as StaffMember[];
}

export async function findMember(userId: string, email: string): Promise<FoundMember | null> {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("staff_find_member", {
    p_actor: userId,
    p_email: email,
  });
  if (error) throw friendlyStaffRoleError(error);
  return (data ?? null) as unknown as FoundMember | null;
}

export async function setStaffRole(
  userId: string,
  memberId: string,
  level: "budtender" | "manager" | "none",
  key: string,
) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("staff_set_role", {
    p_actor: userId,
    p_target: memberId,
    p_role: level,
    p_idempotency_key: key,
  });
  if (error) throw friendlyStaffRoleError(error);
  return data as unknown as { changed: boolean; role: string; previous?: string };
}
