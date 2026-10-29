import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

/** Whether POS sales and online checkout are suspended. No input and nothing but a yes/no leaves the server. */
export const getCommerceStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const { commerceSuspended } = await import("@/lib/commerce-suspension.server");
  try {
    return { suspended: await commerceSuspended() };
  } catch {
    return { suspended: false };
  }
});

export const resumeCommerceFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ reason: z.string().trim().min(3).max(300), key: z.string().min(8).max(100) })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await import("@/lib/commerce-suspension.server")).resumeCommerce(
      context.userId,
      data.reason,
      data.key,
    ),
  );
