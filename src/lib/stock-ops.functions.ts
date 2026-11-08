import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";
import {
  cancelStockTake,
  getStockTake,
  postStockTake,
  quickAdjustStock,
  receiveDelivery,
  recordStockCount,
  recordStockCounts,
  startStockTake,
} from "@/lib/stock-ops.server";

/**
 * /admin → Inventory: stock takes, quick add / remove and deliveries. The acting user comes only from the session;
 * the browser sends ids, quantities and a one-time key, never a role or a price.
 */

const uuid = z.string().uuid();
const key = z.string().min(8).max(120);
const qty = z.number().int();

export const getStockTakeFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => getStockTake(context.userId));

export const startStockTakeFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        note: z.string().trim().max(300).nullable(),
        category: z.string().trim().min(1).max(80).nullable(),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) => startStockTake(context.userId, data));

export const recordStockCountFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ stockTakeId: uuid, productId: uuid, counted: qty.min(0).max(1_000_000), key })
      .parse(d),
  )
  .handler(({ context, data }) => recordStockCount(context.userId, data));

export const recordStockCountsFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        stockTakeId: uuid,
        lines: z
          .array(z.object({ productId: uuid, counted: qty.min(0).max(1_000_000) }))
          .min(1)
          .max(3000)
          .refine(
            (ls) => new Set(ls.map((l) => l.productId)).size === ls.length,
            "Each product once",
          ),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) => recordStockCounts(context.userId, data));

export const postStockTakeFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ stockTakeId: uuid, key }).parse(d))
  .handler(({ context, data }) => postStockTake(context.userId, data));

export const cancelStockTakeFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ stockTakeId: uuid, key }).parse(d))
  .handler(({ context, data }) => cancelStockTake(context.userId, data));

export const quickAdjustStockFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        productId: uuid,
        delta: qty.refine((n) => n !== 0 && Math.abs(n) <= 100_000, "Invalid quantity"),
        reason: z.string().trim().min(3).max(300),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) => quickAdjustStock(context.userId, data));

export const receiveDeliveryFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        supplier: z.string().trim().max(120).nullable(),
        reference: z.string().trim().max(40).nullable(),
        lines: z
          .array(
            z.object({
              productId: uuid,
              quantity: qty.min(1).max(100_000),
              unitCost: z
                .string()
                .regex(/^\d{1,7}(\.\d{1,2})?$/)
                .nullable(),
              expiresOn: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .nullable(),
            }),
          )
          .min(1)
          .max(200),
        key,
      })
      .parse(d),
  )
  .handler(({ context, data }) => receiveDelivery(context.userId, data));
