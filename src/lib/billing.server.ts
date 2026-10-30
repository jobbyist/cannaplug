import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { StaffError } from "@/lib/staff-errors";
import type { BillingAccount, BillingPaymentRow, BillingStatus } from "@/lib/billing";

/** Plain sentences for the rule messages the billing functions raise. */
export function friendlyBillingError(err: unknown): Error {
  const raw =
    err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
  if (/^billing_account_not_found/i.test(raw))
    return new StaffError("That billing account was not found.");
  if (/pending activation/i.test(raw))
    return new StaffError("This service is pending activation and can't be changed yet.");
  if (/only an admin|admin access required/i.test(raw))
    return new StaffError("Only an admin can change payment links.");
  if (/forbidden/i.test(raw)) return new StaffError("Only an admin can do that.");
  if (/^invalid_input: (.+)/i.test(raw))
    return new StaffError(raw.replace(/^invalid_input: /i, ""));
  return err instanceof Error ? err : new Error(raw);
}

export async function listBilling(
  userId: string,
): Promise<{ accounts: BillingAccount[]; payments: BillingPaymentRow[] }> {
  await assertRole(userId, "manager");
  const [acc, pay] = await Promise.all([
    supabaseAdmin.from("billing_accounts").select("*").order("position"),
    supabaseAdmin
      .from("billing_payments")
      .select("id,account_id,provider,currency,status,amount_cents,created_at")
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  if (acc.error) throw friendlyBillingError(acc.error);
  if (pay.error) throw friendlyBillingError(pay.error);
  return {
    accounts: (acc.data ?? []) as unknown as BillingAccount[],
    payments: (pay.data ?? []) as unknown as BillingPaymentRow[],
  };
}

export async function setBillingStatus(
  userId: string,
  slug: string,
  status: Exclude<BillingStatus, "pending">,
  reason: string | null,
  key: string,
) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("billing_set_status", {
    p_actor: userId,
    p_slug: slug,
    p_status: status,
    p_reason: reason,
    p_idempotency_key: key,
  });
  if (error) throw friendlyBillingError(error);
  return data as unknown as { changed: boolean; status: string; previous?: string };
}

export async function setBillingLink(
  userId: string,
  slug: string,
  url: string | null,
  key: string,
) {
  await assertRole(userId, "admin");
  const { data, error } = await supabaseAdmin.rpc("billing_set_payment_link", {
    p_actor: userId,
    p_slug: slug,
    p_url: url,
    p_idempotency_key: key,
  });
  if (error) throw friendlyBillingError(error);
  return data as unknown as { changed: boolean; has_link: boolean };
}

/** A bill paid outside the billing system (bank transfer, card paid directly with the provider). Admins only. */
export async function recordManualPayment(
  userId: string,
  input: {
    slug: string;
    amountCents: number;
    currency: "ZAR" | "USD";
    paidOn: string;
    note: string;
    key: string;
  },
) {
  await assertRole(userId, "admin");
  const { data, error } = await supabaseAdmin.rpc("billing_record_manual_payment", {
    p_actor: userId,
    p_slug: input.slug,
    p_amount_cents: input.amountCents,
    p_currency: input.currency,
    p_paid_on: input.paidOn,
    p_note: input.note,
    p_idempotency_key: input.key,
  });
  if (error) throw friendlyBillingError(error);
  return data as unknown as { recorded: boolean; payment_id: string };
}
