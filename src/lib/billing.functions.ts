import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

/** Billing tab. The acting user always comes from the verified session; the browser names only the account. */
const slug = z.string().regex(/^[a-z0-9-]{2,40}$/);
const key = z.string().min(8).max(100);

export const listBillingFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) =>
    (await import("@/lib/billing.server")).listBilling(context.userId),
  );

export const setBillingStatusFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        slug,
        status: z.enum(["active", "paused", "cancelled"]),
        reason: z
          .string()
          .trim()
          .max(300)
          .nullish()
          .transform((v) => v || null),
        key,
      })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await import("@/lib/billing.server")).setBillingStatus(
      context.userId,
      data.slug,
      data.status,
      data.reason,
      data.key,
    ),
  );

export const setBillingLinkFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        slug,
        url: z
          .string()
          .trim()
          .max(500)
          .nullish()
          .transform((v) => v || null),
        key,
      })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await import("@/lib/billing.server")).setBillingLink(
      context.userId,
      data.slug,
      data.url,
      data.key,
    ),
  );
