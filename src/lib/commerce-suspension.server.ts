import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { MemberError } from "@/lib/member-logic";

/**
 * POS sales and online checkout are suspended while the Shopify Admin/Checkout API bill is unpaid. The state lives in
 * the database (`commerce_suspensions`), so a payment received by the PayPal/Payfast webhook lifts it with no redeploy.
 * Refunds, voids and confirming a payment that is already in flight are never blocked.
 */
export const CHECKOUT_SUSPENDED_MESSAGE =
  "Online checkout is temporarily unavailable. Please check back soon, or visit us in store.";
export const POS_SUSPENDED_MESSAGE =
  "Sales are temporarily paused while the platform bill is settled. They resume automatically once it is paid.";

/** True while a suspension is active. A database without the migration yet (function missing) counts as open. */
export async function commerceSuspended(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("commerce_suspension_status");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") return false;
    throw error;
  }
  return (data as { suspended?: boolean } | null)?.suspended === true;
}

export async function assertCheckoutOpen(): Promise<void> {
  if (await commerceSuspended()) throw new MemberError(CHECKOUT_SUSPENDED_MESSAGE);
}

export async function assertPosOpen(): Promise<void> {
  if (await commerceSuspended()) throw new MemberError(POS_SUSPENDED_MESSAGE);
}

/** Admin: lift the suspension by hand (for example when the bill was settled somewhere the webhooks cannot see). */
export async function resumeCommerce(userId: string, reason: string, key: string) {
  await assertRole(userId, "admin");
  const { data, error } = await supabaseAdmin.rpc("commerce_resume", {
    p_actor: userId,
    p_reason: reason,
    p_idempotency_key: key,
  });
  if (error) throw error;
  return data as unknown as { changed: boolean; suspended: boolean };
}
