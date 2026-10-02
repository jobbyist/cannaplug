import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Server-function boundary for payments. The browser names an order and a provider; the amount, currency,
 * merchant and mode are always read from the database / server config. Nothing here marks an order paid.
 */
const uuid = z.string().uuid();
const origin = async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  return new URL(getRequest().url).origin;
};

export const getOnlineMethodsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { availableOnlineMethods } = await import("@/lib/payments/payments-data.server");
  return availableOnlineMethods();
});

export const startPaymentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z.object({ orderId: uuid, provider: z.enum(["yoco", "paypal"]), key: z.string().min(8).max(120) }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { startMemberPayment } = await import("@/lib/payments/payments-data.server");
    return startMemberPayment(context.userId, data.orderId, data.provider, data.key, await origin());
  });

export const confirmPayPalReturnFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ token: z.string().regex(/^[A-Za-z0-9-]{5,40}$/) }).parse(d))
  .handler(async ({ context, data }) => {
    const { confirmMemberPayPalReturn } = await import("@/lib/payments/payments-data.server");
    return confirmMemberPayPalReturn(context.userId, data.token, await origin());
  });

export const paymentStatusFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ orderId: uuid }).parse(d))
  .handler(async ({ context, data }) => {
    const { memberPaymentStatus } = await import("@/lib/payments/payments-data.server");
    return memberPaymentStatus(context.userId, data.orderId);
  });

// ---- staff (manager+; enforced again in the data layer and by the database) ----

export const getPaymentsOverviewFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => (await import("@/lib/payments/payments-data.server")).getPaymentsOverview(context.userId));

export const submitEftFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        orderId: uuid,
        bankReference: z.string().trim().min(4).max(100),
        amountReceived: z.string().regex(/^[0-9]{1,8}(\.[0-9]{1,2})?$/, "Amount must be a positive number, max 2 decimals"),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await import("@/lib/payments/payments-data.server")).submitEft(context.userId, data.orderId, data.bankReference, Number(data.amountReceived)),
  );

export const approveEftFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ transactionId: uuid }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/payments/payments-data.server")).approveEft(context.userId, data.transactionId),
  );

export const rejectEftFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ transactionId: uuid, reason: z.string().trim().min(3).max(300) }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/payments/payments-data.server")).rejectEft(context.userId, data.transactionId, data.reason),
  );

export const updateFxSettingsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ mode: z.enum(["live", "manual"]), marginPercent: z.number().min(0).max(10) }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/payments/payments-data.server")).updateFxSettings(context.userId, data),
  );

export const setManualFxRateFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ rate: z.number().min(5).max(60), validHours: z.number().int().min(1).max(168) }).parse(d))
  .handler(async ({ context, data }) =>
    (await import("@/lib/payments/payments-data.server")).setManualFxRate(context.userId, data.rate, data.validHours),
  );
