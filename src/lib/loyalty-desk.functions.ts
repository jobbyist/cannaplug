import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";
import {
  getLoyaltyDesk,
  recordPlugBackReturn,
  redeemPlugBack,
  redeemPointsReward,
} from "@/lib/loyalty-desk.server";

/** Server-function boundary for the Loyalty tab: ids and counts only. The actor comes from the signed-in session. */
const uuid = z.string().uuid();
const key = z.string().min(8).max(128);

export const getLoyaltyDeskFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ customerId: uuid }).parse(d))
  .handler(({ context, data }) => getLoyaltyDesk(context.userId, data.customerId));

export const redeemPointsRewardFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        sessionId: uuid,
        customerId: uuid,
        productId: uuid,
        rewardCode: z.string().regex(/^[a-z_]{3,40}$/),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) => redeemPointsReward(context.userId, data));

export const recordPlugBackReturnFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        customerId: uuid,
        tubes: z.number().int().min(1).max(100),
        note: z.string().trim().max(200).optional(),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) => recordPlugBackReturn(context.userId, data));

export const redeemPlugBackFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ sessionId: uuid, customerId: uuid, productId: uuid, key }).parse(d))
  .handler(({ context, data }) => redeemPlugBack(context.userId, data));
