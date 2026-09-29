import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  getAdminDashboard,
  getAdminOrder,
  listAdminOrders,
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

export const getAdminDashboardFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => getAdminDashboard(context.userId));

export const listAdminOrdersFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
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
  .middleware([requireSupabaseAuth])
  .validator((data) => z.object({ orderId: z.string().uuid() }).parse(data))
  .handler(({ context, data }) => getAdminOrder(context.userId, data.orderId));

export const transitionAdminOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
  .middleware([requireSupabaseAuth])
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
  is_active: z.boolean(),
});

export const saveAdminProductFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) =>
    z.object({ productId: z.string().uuid().optional(), input: productSchema }).parse(data),
  )
  .handler(({ context, data }) =>
    saveAdminProduct(context.userId, data.input as AdminProductInput, data.productId),
  );

export const deactivateAdminProductFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data) => z.object({ productId: z.string().uuid() }).parse(data))
  .handler(({ context, data }) => deactivateAdminProduct(context.userId, data.productId));

export const listCustomersFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listCustomers(context.userId));

export const listFulfilmentQueueFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listFulfilmentQueue(context.userId));

export const listStoreProductsFn = createServerFn({ method: "GET" }).handler(() =>
  listStoreProducts(),
);

export const listMemberOrdersFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => listMemberOrders(context.userId));
