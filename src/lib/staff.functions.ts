import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

/** Staff roles. The acting user always comes from the verified session; the browser names only the member. */
export const listStaffFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => (await import("@/lib/staff.server")).listStaff(context.userId));

export const findStaffMemberFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ email: z.string().trim().min(3).max(254) }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/staff.server")).findMember(context.userId, data.email),
  );

export const setStaffRoleFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        memberId: z.string().uuid(),
        level: z.enum(["budtender", "manager", "none"]),
        key: z.string().min(8).max(100),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await import("@/lib/staff.server")).setStaffRole(
      context.userId,
      data.memberId,
      data.level,
      data.key,
    ),
  );
