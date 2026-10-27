import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";
import {
  getIdCredits,
  idCreditsOpen,
  setIdCreditReserve,
  topUpIdCredits,
} from "@/lib/id-credits.server";

const key = z.string().min(8).max(128);
const note = z
  .string()
  .trim()
  .max(200)
  .nullish()
  .transform((v) => (v ? v : null));

export const getIdCreditsFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => getIdCredits(context.userId));

export const topUpIdCreditsFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ credits: z.number().int().min(1).max(100000), note, key }).parse(d))
  .handler(({ context, data }) => topUpIdCredits(context.userId, data));

export const setIdCreditReserveFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z.object({ reserved: z.number().int().min(0).max(1000000), note, key }).parse(d),
  )
  .handler(({ context, data }) => setIdCreditReserve(context.userId, data));

/** Public (sign-up form): yes/no only. */
export const idCreditsOpenFn = createServerFn({ method: "GET" }).handler(() => idCreditsOpen());
