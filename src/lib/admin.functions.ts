import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";
import {
  getAdminDashboard,
  getAdminOrder,
  listAdminOrders,
  confirmOrderPayment,
  listAdminProducts,
  listCustomers,
  listFulfilmentQueue,
  listMemberOrders,
  listStoreProducts,
  saveAdminProduct,
  deactivateAdminProduct,
  transitionAdminOrder,
  type AdminProductInput,
  type AdminOrderStatus,
} from "@/lib/admin-data.server";

/** The signed-in staff member's role, so /admin shows only the tabs they can use. */
export const getMyStaffRoleFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assertRole } = await import("@/lib/admin-data.server");
    return (await assertRole(context.userId, "budtender")) as "budtender" | "manager" | "admin";
  });

/**
 * Whether the signed-in person is staff, without treating "not staff" as an error, so /admin can show a
 * clear "no staff access" screen instead of a failed dashboard.
 */
export const getMyStaffAccessFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { staffRoleOf } = await import("@/lib/admin-data.server");
    return { role: await staffRoleOf(context.userId) };
  });

export const getAdminDashboardFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => getAdminDashboard(context.userId));

export const listAdminOrdersFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z
      .object({
        limit: z.number().int().min(1).max(100).optional(),
        before: z.string().datetime().optional(),
      })
      .default({})
      .parse(data),
  )
  .handler(({ context, data }) =>
    listAdminOrders(context.userId, {
      ...(data.limit ? { limit: data.limit } : {}),
      ...(data.before ? { before: data.before } : {}),
    }),
  );

export const getAdminOrderFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ orderId: z.string().uuid() }).parse(data))
  .handler(({ context, data }) => getAdminOrder(context.userId, data.orderId));

export const transitionAdminOrderFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z
      .object({
        orderId: z.string().uuid(),
        toStatus: z.enum([
          "awaiting_payment",
          "confirmed",
          "packing",
          "ready",
          "out_for_delivery",
          "completed",
          "cancelled",
        ]),
        note: z.string().max(500).optional(),
      })
      .parse(data),
  )
  .handler(({ context, data }) =>
    transitionAdminOrder(
      context.userId,
      data.orderId,
      data.toStatus as AdminOrderStatus,
      data.note,
    ),
  );

export const listAdminProductsFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => listAdminProducts(context.userId));

const productSchema = z.object({
  slug: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  category: z.string().min(1).max(80),
  subcategory: z.string().max(120).nullable(),
  description: z.string().max(2000).nullable(),
  price_rand: z.number().nonnegative(),
  unit: z.string().max(80).nullable(),
  strain_type: z.string().max(80).nullable(),
  badge: z.string().max(80).nullable(),
  sort_order: z.number().int().nonnegative(),
  low_stock_threshold: z.number().int().min(0).max(100000).optional(),
  is_active: z.boolean(),
  sku: z
    .string()
    .trim()
    .max(64)
    .nullish()
    .transform((v) => (v ? v : null)),
  barcode: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,48}$/, "Barcode: 4-48 letters, digits or dashes")
    .or(z.literal(""))
    .nullish()
    .transform((v) => (v ? v : null)),
  cost_rand: z.number().nonnegative().max(1_000_000).nullish(),
  brand: z
    .string()
    .trim()
    .max(80)
    .nullish()
    .transform((v) => (v ? v : null)),
  sell_online: z.boolean().optional(),
  sold_by_weight: z.boolean().optional(),
  weight_step_g: z.union([z.literal(0.5), z.literal(1)]).optional(),
  sale_price_rand: z.number().nonnegative().max(1_000_000).nullish(),
  sale_ends_at: z.string().datetime({ offset: true }).nullish(),
  is_featured: z.boolean().optional(),
});

export const saveAdminProductFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z.object({ productId: z.string().uuid().optional(), input: productSchema }).parse(data),
  )
  .handler(({ context, data }) =>
    saveAdminProduct(context.userId, data.input as AdminProductInput, data.productId),
  );

export const deactivateAdminProductFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ productId: z.string().uuid() }).parse(data))
  .handler(({ context, data }) => deactivateAdminProduct(context.userId, data.productId));

export const listCustomersFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => listCustomers(context.userId));

export const listFulfilmentQueueFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(({ context }) => listFulfilmentQueue(context.userId));

export const listStoreProductsFn = createServerFn({ method: "GET" }).handler(() =>
  listStoreProducts(),
);

export const getHomeCatalogueFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getHomeCatalogue } = await import("@/lib/admin-data.server");
  return getHomeCatalogue();
});

export const listMemberOrdersFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listMemberOrders(context.userId));

export const confirmOrderPaymentFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z
      .object({
        orderId: z.string().uuid(),
        bankReference: z.string().trim().min(4).max(100),
        amountReceived: z
          .string()
          .regex(/^[0-9]{1,8}(\.[0-9]{1,2})?$/, "Amount must be a positive number, max 2 decimals"),
      })
      .parse(data),
  )
  .handler(({ context, data }) =>
    confirmOrderPayment(
      context.userId,
      data.orderId,
      data.bankReference,
      Number(data.amountReceived),
    ),
  );

export const createProductImageUploadFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z
      .object({
        productId: z.string().uuid(),
        mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
      })
      .parse(data),
  )
  .handler(async ({ context, data }) => {
    const { createProductImageUpload } = await import("@/lib/product-media.server");
    return createProductImageUpload(context.userId, data.productId, data.mime);
  });

export const attachProductImageFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) =>
    z.object({ productId: z.string().uuid(), path: z.string().min(10).max(200) }).parse(data),
  )
  .handler(async ({ context, data }) => {
    const { attachProductImage } = await import("@/lib/product-media.server");
    return attachProductImage(context.userId, data.productId, data.path);
  });

export const removeProductImageFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((data) => z.object({ productId: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }) => {
    const { removeProductImage } = await import("@/lib/product-media.server");
    return removeProductImage(context.userId, data.productId);
  });
