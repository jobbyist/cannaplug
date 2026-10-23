import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PUSH_TOPICS } from "@/lib/push-topics";

/**
 * /account → Notifications. Member-scoped: every function acts for the signed-in member (`userId` comes
 * from the verified JWT in the server function), and the database functions enforce it again.
 */
const unwrap = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};

async function isStaff(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).some((r) => ["budtender", "manager", "admin"].includes(r.role));
}

export async function getPushSettings(userId: string) {
  const [devices, prefs, staff] = await Promise.all([
    supabaseAdmin
      .from("push_subscriptions")
      .select("id,user_agent,created_at,last_success_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("notification_preferences")
      .select("topic,push_enabled")
      .eq("user_id", userId),
    isStaff(userId),
  ]);
  const chosen = new Map((prefs.data ?? []).map((p) => [p.topic, p.push_enabled]));
  return {
    vapidPublicKey: process.env["VAPID_PUBLIC_KEY"]?.trim() || null,
    devices: unwrap(devices) ?? [],
    topics: PUSH_TOPICS.filter((t) => staff || !t.staff).map((t) => ({
      ...t,
      enabled: chosen.get(t.id) ?? t.defaultOn,
    })),
  };
}

export async function subscribePush(
  userId: string,
  sub: { endpoint: string; p256dh: string; auth: string },
  userAgent: string | null,
  key: string,
) {
  return unwrap(
    await supabaseAdmin.rpc("push_subscribe", {
      p_actor: userId,
      p_endpoint: sub.endpoint,
      p_p256dh: sub.p256dh,
      p_auth: sub.auth,
      p_user_agent: userAgent,
      p_idempotency_key: key,
    }),
  );
}

export async function unsubscribePush(userId: string, endpoint: string) {
  return unwrap(
    await supabaseAdmin.rpc("push_unsubscribe", { p_actor: userId, p_endpoint: endpoint }),
  );
}

/** Removes one of the member's own devices by id (the lookup is scoped to the member). */
export async function removePushDevice(userId: string, id: string) {
  const { data } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return 0;
  return unsubscribePush(userId, data.endpoint);
}

export async function setPushTopic(userId: string, topic: string, enabled: boolean, key: string) {
  return unwrap(
    await supabaseAdmin.rpc("notification_set_preference", {
      p_actor: userId,
      p_topic: topic,
      p_enabled: enabled,
      p_idempotency_key: key,
    }),
  );
}

/** Queues a test push to the member's own devices (at most one a minute). */
export async function sendTestPush(userId: string) {
  const minute = new Date().toISOString().slice(0, 16);
  const id = unwrap(
    await supabaseAdmin.rpc("notification_enqueue_push", {
      p_user: userId,
      p_template: "push_test",
      p_category: "transactional",
      p_data: {},
      p_dedupe_key: `pushtest:${userId}:${minute}`,
    }),
  );
  return { queued: !!id };
}
