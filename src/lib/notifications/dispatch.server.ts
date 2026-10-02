import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adaptersFromEnv, type Fetch } from "./adapters";
import { dispatchBatch, type NotificationDb, type QueuedNotification } from "./dispatch";

const nodeFetch: Fetch = async (u, i) => {
  const r = await fetch(u, i as RequestInit);
  return { ok: r.ok, status: r.status, text: () => r.text() };
};

function supabaseNotificationDb(): NotificationDb {
  return {
    async claim(limit, lease) {
      const { data, error } = await supabaseAdmin.rpc("notification_claim", { p_limit: limit, p_lease_seconds: lease });
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({
        id: r.id, channel: r.channel as QueuedNotification["channel"], template: r.template, recipient: r.recipient,
        data: (r.data ?? {}) as Record<string, unknown>, attempts: r.attempts,
      }));
    },
    async complete(id, r) {
      const { error } = await supabaseAdmin.rpc("notification_complete", {
        p_id: id, p_ok: r.ok, p_provider_message_id: r.ok ? r.messageId : null,
        p_error: r.ok ? null : r.error, p_permanent: r.ok ? false : r.permanent,
      });
      if (error) throw new Error(error.message);
    },
  };
}

export async function runNotificationDispatch(siteUrlFallback = "https://cannaplug.co.za", limit = 25) {
  return dispatchBatch(
    {
      db: supabaseNotificationDb(),
      adapters: adaptersFromEnv(process.env, nodeFetch),
      siteUrl: (process.env["SITE_URL"] ?? siteUrlFallback).trim(),
    },
    limit,
  );
}
