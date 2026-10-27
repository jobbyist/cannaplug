import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

/**
 * ID-check credits (/admin → ID checks). Every rule lives in the database (see 20261027002000_id_check_credits):
 * these wrappers pass the signed-in staff member as p_actor and the RPCs check their role.
 */

export type IdCreditMovement = {
  id: number;
  kind: "opening" | "top_up" | "charge" | "reserve" | "release" | "adjustment";
  credits: number;
  reserved_delta: number;
  note: string | null;
  created_at: string;
};

export type IdCreditSummary = {
  total: number;
  reserved: number;
  available: number;
  cost_per_check: number;
  low_balance_threshold: number;
  checks_left: number | null;
  reserved_checks_left: number | null;
  used_last_30_days: number;
  charged_members: number;
  low_alert_sent_at: string | null;
  alert_emails: string[];
  recent: IdCreditMovement[];
};

function unwrap<T>(res: { data: Json | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export async function getIdCredits(userId: string): Promise<IdCreditSummary> {
  return unwrap(await supabaseAdmin.rpc("id_credits_summary", { p_actor: userId }));
}

export async function topUpIdCredits(
  userId: string,
  input: { credits: number; note: string | null; key: string },
) {
  return unwrap<{ total: number; reserved: number; available: number }>(
    await supabaseAdmin.rpc("id_credits_top_up", {
      p_actor: userId,
      p_credits: input.credits,
      p_note: input.note,
      p_idempotency_key: input.key,
    }),
  );
}

export async function setIdCreditReserve(
  userId: string,
  input: { reserved: number; note: string | null; key: string },
) {
  return unwrap<{ total: number; reserved: number; available: number }>(
    await supabaseAdmin.rpc("id_credits_set_reserve", {
      p_actor: userId,
      p_reserved: input.reserved,
      p_note: input.note,
      p_idempotency_key: input.key,
    }),
  );
}

/** Public: can a new member be ID-checked right now? Only a yes/no leaves the server. Fails open on error so a
 *  database hiccup never hides the sign-up form; the database still refuses the ID upload when credits are out. */
export async function idCreditsOpen(): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("id_credits_open");
  if (error) return true;
  return data !== false;
}
