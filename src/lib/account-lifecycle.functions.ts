import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

const key = z.string().min(8).max(100);

/** The signed-in member's own account status. */
export const getMyAccountStateFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getAccountState } = await import("@/lib/account-lifecycle.server");
    return getAccountState(context.userId);
  });

/** Deactivate, reactivate, or ask for deletion. The user is always the signed-in member, never a posted id. */
export const setMyAccountStatusFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z.object({ action: z.enum(["deactivate", "reactivate", "request_deletion"]), key }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { setAccountStatus } = await import("@/lib/account-lifecycle.server");
    return setAccountStatus(context.userId, data.action, data.key);
  });

/** Admin only: complete a member's deletion (anonymise), with a written reason. */
export const deleteMemberAccountFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ memberId: z.string().uuid(), reason: z.string().trim().min(3).max(200), key })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { deleteMemberAccount } = await import("@/lib/account-lifecycle.server");
    return deleteMemberAccount(context.userId, data.memberId, data.reason, data.key);
  });
