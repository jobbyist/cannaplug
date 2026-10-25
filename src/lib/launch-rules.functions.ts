import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

const key = z.string().min(8).max(100);

export const listPurchaseLimitsFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { listPurchaseLimits } = await import("@/lib/launch-rules.server");
    return listPurchaseLimits(context.userId);
  });

export const setPurchaseLimitFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        category: z.string().min(1).max(40),
        dailyMax: z.number().int().min(1).max(100000),
        enabled: z.boolean(),
        key,
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { setPurchaseLimit } = await import("@/lib/launch-rules.server");
    return setPurchaseLimit(context.userId, data.category, data.dailyMax, data.enabled, data.key);
  });

export const resetVerificationAttemptsFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ memberId: z.string().uuid(), reason: z.string().trim().min(10).max(300), key })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { resetVerificationAttempts } = await import("@/lib/launch-rules.server");
    return resetVerificationAttempts(context.userId, data.memberId, data.reason, data.key);
  });
