import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";
import {
  adjustStock,
  findPosSale,
  getPosOverview,
  listBatches,
  posAddExpense,
  posCloseSession,
  posCompleteSale,
  posOpenSession,
  posRefundSale,
  posReviewSession,
  posVoidExpense,
  posVoidSale,
  receiveStock,
  upsertDrawer,
} from "@/lib/pos-data.server";
import { assertRole } from "@/lib/admin-data.server";

/**
 * Server-function boundary for the POS. Inputs are validated here; the acting user comes ONLY from
 * the authenticated context. The browser never supplies prices, totals, stock levels or an actor.
 */

const idempotencyKey = z.string().min(8).max(128);
const uuid = z.string().uuid();
const money = z
  .string()
  .regex(/^[0-9]{1,8}(\.[0-9]{1,2})?$/, "Amount must be a positive number with at most 2 decimals");
const method = z.enum(["cash", "card", "eft", "paypal"]);
const reference = z.string().trim().min(4).max(100).optional();

export const getPosOverviewFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => getPosOverview(context.userId));

export const openPosSessionFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ drawerId: uuid, openingFloat: money, key: idempotencyKey }).parse(d))
  .handler(({ context, data }) =>
    posOpenSession(context.userId, data.drawerId, data.openingFloat, data.key),
  );

export const closePosSessionFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        sessionId: uuid,
        actualCash: money,
        cashDeposited: money,
        note: z.string().max(500).optional(),
        key: idempotencyKey,
      })
      .refine((v) => Number(v.cashDeposited) <= Number(v.actualCash), {
        message: "The deposit cannot be more than the cash counted",
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    posCloseSession(
      context.userId,
      data.sessionId,
      data.actualCash,
      data.cashDeposited,
      data.note,
      data.key,
    ),
  );

/** Cash paid out of the till for a store expense. Descriptions must never hold customer, ID or health details. */
export const addPosExpenseFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        sessionId: uuid,
        amount: money,
        category: z.enum([
          "supplies",
          "cleaning",
          "transport",
          "food",
          "maintenance",
          "stock",
          "other",
        ]),
        description: z.string().trim().min(3).max(200),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    posAddExpense(
      context.userId,
      data.sessionId,
      data.amount,
      data.category,
      data.description,
      data.key,
    ),
  );

export const voidPosExpenseFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ expenseId: uuid, reason: z.string().trim().min(3).max(200), key: idempotencyKey })
      .parse(d),
  )
  .handler(({ context, data }) =>
    posVoidExpense(context.userId, data.expenseId, data.reason, data.key),
  );

export const reviewPosSessionFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ sessionId: uuid, approve: z.boolean(), note: z.string().trim().min(3).max(500) })
      .parse(d),
  )
  .handler(({ context, data }) =>
    posReviewSession(context.userId, data.sessionId, data.approve, data.note),
  );

const discount = z
  .object({
    kind: z.enum(["percent", "amount"]),
    value: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
  })
  .strict();

export const completePosSaleFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        sessionId: uuid,
        // Only ids and quantities: no price, total or stock value is accepted from the client.
        items: z
          .array(
            z.object({
              product_id: uuid,
              quantity: z.number().int().min(1).max(9999),
              discount: discount.optional(),
            }),
          )
          .min(1)
          .max(100),
        // A sale with a 100% discount totals R0 and takes no payment; the database checks the payments equal the total.
        tenders: z.array(z.object({ method, amount: money, reference })).max(8),
        customerId: uuid.nullable(),
        // Only the kind and the typed value: the database works out the cents.
        orderDiscount: discount.nullable().default(null),
        discountReason: z.string().trim().min(3).max(200).nullable().default(null),
        key: idempotencyKey,
      })
      .strict()
      .parse(d),
  )
  .handler(({ context, data }) => posCompleteSale(context.userId, data));

export const voidPosSaleFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({ saleId: uuid, reason: z.string().trim().min(3).max(500), key: idempotencyKey })
      .parse(d),
  )
  .handler(({ context, data }) => posVoidSale(context.userId, data.saleId, data.reason, data.key));

export const refundPosSaleFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        saleId: uuid,
        sessionId: uuid,
        items: z
          .array(z.object({ sale_item_id: uuid, quantity: z.number().int().min(1).max(9999) }))
          .min(1)
          .max(100),
        payouts: z
          .array(z.object({ method, amount: money, reference }))
          .min(1)
          .max(4),
        reason: z.string().trim().min(3).max(500),
        restock: z.boolean(),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) => posRefundSale(context.userId, data));

export const findPosSaleFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ receipt: z.string().trim().min(4).max(40) }).parse(d))
  .handler(({ context, data }) => findPosSale(context.userId, data.receipt));

export const listBatchesFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) => z.object({ productId: uuid }).parse(d))
  .handler(({ context, data }) => listBatches(context.userId, data.productId));

export const receiveStockFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        productId: uuid,
        batchCode: z.string().trim().min(1).max(60),
        quantity: z.number().int().min(1).max(100000),
        expiresAt: z.string().datetime().nullable(),
        unitCost: money.nullable(),
        notes: z.string().max(500).nullable(),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) => receiveStock(context.userId, data));

export const adjustStockFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        batchId: uuid,
        delta: z
          .number()
          .int()
          .refine((n) => n !== 0 && Math.abs(n) <= 100000, "Invalid quantity"),
        reason: z.string().trim().min(3).max(300),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) => adjustStock(context.userId, data));

export const upsertDrawerFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        drawerId: uuid.nullable(),
        name: z.string().trim().min(1).max(80),
        location: z.string().trim().max(120).nullable(),
        isActive: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) => {
    await assertRole(context.userId, "manager");
    return upsertDrawer(context.userId, data);
  });
