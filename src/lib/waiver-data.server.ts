import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";

/** Dab waiver data layer. Every call passes the signed-in person as p_actor; the database checks the role
 *  (any staff can sign someone in, only managers and admins can read waivers back). */

export type WaiverForm = {
  customer_name: string;
  date_of_birth: string;
  id_number: string;
  age_confirmed: boolean;
  popia_consent: boolean;
  alcohol: { had: boolean; hours_ago?: number | null | undefined };
  drugs: { had: boolean; details?: string | null };
  medication: { had: boolean; details?: string | null };
  under_influence: boolean;
  conditions: string[];
  condition_details?: string | null;
  emergency: {
    name: string;
    relationship?: string | null;
    phone: string;
    alt_phone?: string | null;
  };
  signature?: string | null | undefined;
  staff_noted_signs: boolean;
  staff_details?: string | null;
};

export type WaiverResult = {
  id: string;
  status: "valid" | "declined";
  decline_reasons: string[];
  flagged: boolean;
};

export type WaiverSummary = {
  id: string;
  signed_at: string;
  customer_name: string;
  status: "valid" | "declined";
  decline_reasons: string[];
  flagged: boolean;
  staff_name: string;
  used: boolean;
  has_incident: boolean;
};

export type WaiverRecord = {
  id: string;
  status: "valid" | "declined";
  decline_reasons: string[];
  flagged: boolean;
  signed_at: string;
  retain_until: string;
  customer_name: string;
  date_of_birth: string;
  id_number: string;
  age_confirmed: boolean;
  screening: {
    alcohol: { had: boolean; hours_ago: number | null };
    drugs: { had: boolean; details: string | null };
    medication: { had: boolean; details: string | null };
    under_influence: boolean;
    conditions: string[];
    condition_details: string | null;
  };
  emergency: {
    name: string;
    relationship: string | null;
    phone: string;
    alt_phone: string | null;
  };
  signature: string | null;
  staff_name: string;
  staff_noted_signs: boolean;
  staff_details: string | null;
  sale_id: string | null;
  receipt_number: string | null;
  incident: {
    text: string;
    emergency_services: boolean;
    emergency_contact: boolean;
    time: string | null;
    notes: string | null;
    recorded_at: string;
  } | null;
};

function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export async function createDabWaiver(userId: string, form: WaiverForm): Promise<WaiverResult> {
  return unwrap(
    await supabaseAdmin.rpc("dab_waiver_create", {
      p_actor: userId,
      p_payload: form as unknown as Json,
    }),
  ) as unknown as WaiverResult;
}

export async function getDabWaiver(userId: string, waiverId: string): Promise<WaiverRecord> {
  return unwrap(
    await supabaseAdmin.rpc("dab_waiver_get", { p_actor: userId, p_waiver_id: waiverId }),
  ) as unknown as WaiverRecord;
}

export async function listDabWaivers(
  userId: string,
  opts: { search?: string | undefined; before?: string | undefined; limit?: number | undefined },
): Promise<WaiverSummary[]> {
  return unwrap(
    await supabaseAdmin.rpc("dab_waiver_list", {
      p_actor: userId,
      p_limit: opts.limit ?? 50,
      ...(opts.before ? { p_before: opts.before } : {}),
      ...(opts.search ? { p_search: opts.search } : {}),
    }),
  ) as unknown as WaiverSummary[];
}

export async function recordWaiverIncident(
  userId: string,
  input: {
    waiverId: string;
    text: string;
    emergencyServices: boolean;
    emergencyContact: boolean;
    time: string | null;
    notes: string | null;
  },
): Promise<void> {
  unwrap(
    await supabaseAdmin.rpc("dab_waiver_record_incident", {
      p_actor: userId,
      p_waiver_id: input.waiverId,
      p_text: input.text,
      p_emergency_services: input.emergencyServices,
      p_emergency_contact: input.emergencyContact,
      p_incident_time: input.time ?? "",
      p_notes: input.notes ?? "",
    }),
  );
}
