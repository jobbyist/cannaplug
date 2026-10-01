import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  checkReorder,
  createReorder,
  deleteMemberAddress,
  getMemberAccount,
  redeemLoyaltyPoints,
  saveMemberAddress,
  setDefaultMemberAddress,
  setStockAlert,
  setWishlist,
  type UserClient,
} from "@/lib/member-data.server";
import { friendlyMemberError } from "@/lib/member-logic";

/**
 * Server-function boundary for /account. The acting member comes ONLY from the verified JWT in
 * `context`; inputs here never carry a user id, price, total or points balance.
 */

const uuid = z.string().uuid();
const idempotencyKey = z.string().min(8).max(120);
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const addressSchema = z.object({
  label: z.string().trim().min(1).max(40),
  recipient_name: text(160),
  phone: text(40),
  line1: z.string().trim().min(3).max(200),
  line2: text(200),
  suburb: text(100),
  city: text(100),
  province: text(100),
  postal_code: text(12),
  delivery_notes: text(500),
});

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw friendlyMemberError(err);
  }
}

export const getMemberAccountFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => run(() => getMemberAccount(context.supabase as UserClient)));

export const saveAddressFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        addressId: uuid.nullable().optional(),
        address: addressSchema,
        makeDefault: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() =>
      saveMemberAddress(
        context.userId,
        data.addressId ?? null,
        data.address,
        data.makeDefault ?? false,
      ),
    ),
  );

export const setDefaultAddressFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ addressId: uuid }).parse(d))
  .handler(({ context, data }) =>
    run(() => setDefaultMemberAddress(context.userId, data.addressId)),
  );

export const deleteAddressFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ addressId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => deleteMemberAddress(context.userId, data.addressId)));

export const redeemPointsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        orderId: uuid,
        points: z.number().int().min(1).max(10_000_000),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() => redeemLoyaltyPoints(context.userId, data.orderId, data.points, data.key)),
  );

export const reorderPreviewFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ orderId: uuid }).parse(d))
  .handler(({ context, data }) => run(() => checkReorder(context.userId, data.orderId)));

export const reorderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        orderId: uuid,
        // The total the member was shown. The database refuses if the live total differs.
        expectedTotal: z.number().nonnegative().max(10_000_000),
        key: idempotencyKey,
      })
      .parse(d),
  )
  .handler(({ context, data }) =>
    run(() => createReorder(context.userId, data.orderId, data.expectedTotal, data.key)),
  );

export const setWishlistFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ productId: uuid, saved: z.boolean() }).parse(d))
  .handler(({ context, data }) =>
    run(() =>
      setWishlist(context.supabase as UserClient, context.userId, data.productId, data.saved),
    ),
  );

export const setStockAlertFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ productId: uuid, enabled: z.boolean() }).parse(d))
  .handler(({ context, data }) =>
    run(() =>
      setStockAlert(context.supabase as UserClient, context.userId, data.productId, data.enabled),
    ),
  );
