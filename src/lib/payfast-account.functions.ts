import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

/** The PayFast account balance, payouts and fees for the admin Payments tab. Managers and admins only. */
export const getPayfastAccountFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) =>
    (await import("@/lib/payments/payfast-account.server")).getPayfastAccount(context.userId),
  );
