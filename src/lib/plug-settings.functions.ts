import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

/** Ask The Plug safety buffer (/admin → Settings). Managers and admins read and edit; checked again in the database. */
export const getPlugSettingsFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getPlugSettings } = await import("@/lib/plug-settings.server");
    return getPlugSettings(context.userId);
  });

export const setPlugSettingsFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        bufferDefault: z.number().int().min(1).max(50),
        bufferFast: z.number().int().min(1).max(100),
        fastUnits: z.number().int().min(1).max(10000),
        key: z.string().min(8).max(100),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    const { setPlugSettings } = await import("@/lib/plug-settings.server");
    return setPlugSettings(context.userId, data);
  });
