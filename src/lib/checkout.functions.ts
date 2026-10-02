import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  listCheckoutAddresses,
  listDeliveryOptions,
  placeCheckoutOrder,
  quoteCheckout,
} from "@/lib/checkout-data.server";
import type { UserClient } from "@/lib/member-data.server";
import { friendlyMemberError } from "@/lib/member-logic";

/**
 * Server-function boundary for /checkout. No price, fee, total-to-charge or user id is ever read from
 * the browser as an authority: `expectedTotal` is only the figure the member was shown, and the
 * database refuses the order if it is not the live total.
 */

const uuid = z.string().uuid();
const items = z
  .array(z.object({ productId: uuid, quantity: z.number().int().min(1).max(999) }))
  .min(1)
  .max(100);
const deliveryMethod = z.string().regex(/^[a-z0-9_]{2,40}$/);

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw friendlyMemberError(err);
  }
}

export const listDeliveryOptionsFn = createServerFn({ method: "GET" }).handler(() =>
  run(() => listDeliveryOptions()),
);

export const listCheckoutAddressesFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(({ context }) => run(() => listCheckoutAddresses(context.supabase as UserClient)));

export const quoteCheckoutFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ items, deliveryMethod }).parse(d))
  .handler(({ data }) => run(() => quoteCheckout(data.items, data.deliveryMethod)));

export const placeOrderFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        items,
        contactName: z.string().trim().min(2).max(160),
        contactPhone: z
          .string()
          .trim()
          .regex(/^[0-9+() -]{7,40}$/),
        deliveryMethod,
        addressId: uuid,
        paymentMethod: z.enum(["eft", "card", "paypal"]),
        // The total the member was shown; the database rejects the order if it is not the live total.
        expectedTotal: z.number().nonnegative().max(10_000_000),
        notes: z.string().trim().max(500).nullable(),
        key: z.string().min(8).max(120),
      })
      .parse(d),
  )
  .handler(({ context, data }) => run(() => placeCheckoutOrder(context.userId, data)));
