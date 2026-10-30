import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";

export async function getPlugSettings(userId: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin
    .from("plug_settings")
    .select("buffer_default,buffer_fast,fast_seller_units_7d,updated_at")
    .eq("id", true)
    .maybeSingle();
  if (error) throw error;
  return {
    bufferDefault: data?.buffer_default ?? 2,
    bufferFast: data?.buffer_fast ?? 4,
    fastUnits: data?.fast_seller_units_7d ?? 10,
    updatedAt: data?.updated_at ?? null,
  };
}

export async function setPlugSettings(
  userId: string,
  v: { bufferDefault: number; bufferFast: number; fastUnits: number; key: string },
) {
  await assertRole(userId, "manager");
  const { error } = await supabaseAdmin.rpc("plug_settings_set", {
    p_actor: userId,
    p_buffer_default: v.bufferDefault,
    p_buffer_fast: v.bufferFast,
    p_fast_units: v.fastUnits,
    p_idempotency_key: v.key,
  });
  if (error) throw error;
  return getPlugSettings(userId);
}
