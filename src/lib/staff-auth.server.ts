import { createMiddleware, createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AppRole = Database["public"]["Enums"]["app_role"];
export type StaffRole = Exclude<AppRole, "customer">;

const ROLE_LEVEL: Record<AppRole, number> = {
  customer: 10,
  budtender: 20,
  manager: 30,
  admin: 40,
};

type AuthenticatedSupabase = SupabaseClient<Database>;

export async function getCurrentUserRole(
  supabase: AuthenticatedSupabase,
): Promise<AppRole | null> {
  const { data, error } = await supabase.rpc("current_user_role");
  if (error) throw error;
  return data;
}

export async function assertStaffAccess(
  supabase: AuthenticatedSupabase,
  minimumRole: StaffRole = "budtender",
): Promise<StaffRole> {
  const role = await getCurrentUserRole(supabase);

  if (!role || ROLE_LEVEL[role] < ROLE_LEVEL[minimumRole]) {
    const error = new Error("Forbidden: staff access required") as Error & {
      statusCode?: number;
    };
    error.statusCode = 403;
    throw error;
  }

  return role;
}

export function createStaffAuthorizationMiddleware(minimumRole: StaffRole = "budtender") {
  return createMiddleware({ type: "function" })
    .middleware([requireSupabaseAuth])
    .server(async ({ next, context }) => {
      await assertStaffAccess(context.supabase, minimumRole);
      return next();
    });
}

export const getStaffAuthorization = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const role = await getCurrentUserRole(context.supabase);
    const authorized = Boolean(role && ROLE_LEVEL[role] >= ROLE_LEVEL.budtender);

    return {
      authorized,
      role,
      userId: context.userId,
    };
  });

export async function assertBudtenderAccess(
  supabase: AuthenticatedSupabase,
): Promise<"budtender" | "manager" | "admin"> {
  return assertStaffAccess(supabase, "budtender");
}

export async function assertManagerAccess(
  supabase: AuthenticatedSupabase,
): Promise<"manager" | "admin"> {
  const role = await assertStaffAccess(supabase, "manager");
  return role as "manager" | "admin";
}

export async function assertAdminAccess(
  supabase: AuthenticatedSupabase,
): Promise<"admin"> {
  const role = await assertStaffAccess(supabase, "admin");
  return role as "admin";
}
