import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

const opt = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Staff write notices here; staff read them straight from the database under RLS and Realtime. */
export const saveTeamNoticeFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        id: z.string().uuid().nullable(),
        key: z.string().min(8).max(100),
        notice: z.object({
          title: z.string().trim().min(3).max(120),
          body: z.string().trim().min(1).max(1000),
          kind: z.enum(["update", "reminder", "alert"]),
          audience: z.enum(["budtender", "manager", "admin"]),
          status: z.enum(["draft", "published", "archived"]),
          pinned: z.boolean(),
          changeAt: z.string().datetime().nullable(),
          changeTitle: opt(120),
          changeBody: opt(1000),
        }),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await import("@/lib/team-notifications.server")).saveNotice(
      context.userId,
      data.id,
      data.notice,
      data.key,
    ),
  );

export const markTeamNoticesReadFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/team-notifications.server")).markNoticesRead(context.userId, data.ids),
  );
