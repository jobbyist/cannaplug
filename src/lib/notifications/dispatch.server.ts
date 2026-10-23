import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adaptersFromEnv, type Fetch } from "./adapters";
import { dispatchBatch, type NotificationDb, type QueuedNotification } from "./dispatch";
import { pushAdapter, vapidFromEnv, type PushFetch, type PushStore } from "./push";

const nodeFetch: Fetch = async (u, i) => {
  const r = await fetch(u, i as RequestInit);
  return { ok: r.ok, status: r.status, text: () => r.text() };
};

function supabaseNotificationDb(): NotificationDb {
  return {
    async claim(limit, lease, channels) {
      const { data, error } = await supabaseAdmin.rpc("notification_claim_channels", {
        p_limit: limit,
        p_lease_seconds: lease,
        p_channels: channels,
      });
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({
        id: r.id,
        channel: r.channel as QueuedNotification["channel"],
        template: r.template,
        recipient: r.recipient,
        data: (r.data ?? {}) as Record<string, unknown>,
        attempts: r.attempts,
      }));
    },
    async complete(id, r) {
      const { error } = await supabaseAdmin.rpc("notification_complete", {
        p_id: id,
        p_ok: r.ok,
        p_provider_message_id: r.ok ? r.messageId : null,
        p_error: r.ok ? null : r.error,
        p_permanent: r.ok ? false : r.permanent,
      });
      if (error) throw new Error(error.message);
    },
  };
}

const pushFetch: PushFetch = async (u, i) => {
  const r = await fetch(u, { method: i.method, headers: i.headers, body: i.body as BodyInit });
  return { status: r.status, text: () => r.text() };
};

function supabasePushStore(): PushStore {
  return {
    async devices(userId) {
      const { data, error } = await supabaseAdmin
        .from("push_subscriptions")
        .select("endpoint,p256dh,auth,topics")
        .eq("user_id", userId);
      if (error) throw new Error(error.message);
      return (data ?? []).map((d) => ({ ...d, topics: d.topics ?? [] }));
    },
    async record(endpoint, outcome) {
      const { error } = await supabaseAdmin.rpc("push_record_delivery", {
        p_endpoint: endpoint,
        p_outcome: outcome,
      });
      if (error) throw new Error(error.message);
    },
  };
}

export async function runNotificationDispatch(
  siteUrlFallback = "https://cannaplug012.co.za",
  limit = 25,
) {
  return dispatchBatch(
    {
      db: supabaseNotificationDb(),
      adapters: (() => {
        const a = adaptersFromEnv(process.env, nodeFetch);
        const vapid = vapidFromEnv(process.env);
        if (vapid) a.push = pushAdapter({ store: supabasePushStore(), vapid, fetch: pushFetch });
        return a;
      })(),
      siteUrl: (process.env["SITE_URL"] ?? siteUrlFallback).trim(),
    },
    limit,
  );
}
