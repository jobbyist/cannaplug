import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { friendlyMemberError } from "@/lib/member-logic";

/**
 * Checkout data layer. The browser supplies product ids + quantities, ONE of its own saved address
 * ids, a delivery option code, contact details and the total it displayed. Prices, fees, stock and
 * the final total are computed by the database; the acting member is the verified JWT subject.
 */
type UserClient = SupabaseClient<Database>;

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw friendlyMemberError(res.error);
  return res.data as T;
}

export type CheckoutItem = { productId: string; quantity: number };

const toRpcItems = (items: CheckoutItem[]): Json =>
  items.map((i) => ({ product_id: i.productId, quantity: i.quantity }));

export type CheckoutQuoteLine = {
  product_id: string;
  name: string;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  available: number;
  status: "ok" | "insufficient_stock" | "unavailable";
};

export type CheckoutQuote = {
  lines: CheckoutQuoteLine[];
  orderable: boolean;
  subtotal: number;
  delivery_method: string;
  delivery_label: string;
  delivery_fee: number;
  total: number | null;
};

export type PlacedOrder = {
  order_id: string;
  order_number: string;
  status: string;
  subtotal: number;
  delivery_fee: number;
  total: number;
  payment_method: string;
  hold_minutes: number;
  replayed?: boolean;
};

export async function listDeliveryOptions() {
  const { data, error } = await supabaseAdmin
    .from("delivery_options")
    .select("code,label,description,fee_rand")
    .eq("is_active", true)
    .order("sort_order");
  if (error) throw friendlyMemberError(error);
  return data ?? [];
}

export async function quoteCheckout(items: CheckoutItem[], deliveryMethod: string) {
  return unwrap(
    await supabaseAdmin.rpc("checkout_quote", {
      p_items: toRpcItems(items),
      p_delivery_method: deliveryMethod,
    }),
  ) as unknown as CheckoutQuote;
}

export async function listCheckoutAddresses(db: UserClient) {
  // RLS: only the signed-in member's own addresses are returned.
  return (
    unwrap(
      await db
        .from("addresses")
        .select(
          "id,label,recipient_name,phone,line1,line2,suburb,city,province,postal_code,delivery_notes,is_default",
        )
        .order("is_default", { ascending: false })
        .order("updated_at", { ascending: false }),
    ) ?? []
  );
}

export type PlaceOrderInput = {
  items: CheckoutItem[];
  contactName: string;
  contactPhone: string;
  deliveryMethod: string;
  addressId: string;
  paymentMethod: "eft";
  expectedTotal: number;
  notes: string | null;
  key: string;
};

export async function placeCheckoutOrder(userId: string, input: PlaceOrderInput) {
  return unwrap(
    await supabaseAdmin.rpc("checkout_place_order", {
      p_user_id: userId,
      p_items: toRpcItems(input.items),
      p_contact_name: input.contactName,
      p_contact_phone: input.contactPhone,
      p_delivery_method: input.deliveryMethod,
      p_address_id: input.addressId,
      p_payment_method: input.paymentMethod,
      p_expected_total: input.expectedTotal,
      p_notes: input.notes,
      p_idempotency_key: input.key,
    }),
  ) as unknown as PlacedOrder;
}
