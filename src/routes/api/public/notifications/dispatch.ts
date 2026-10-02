import { createFileRoute } from "@tanstack/react-router";

/**
 * Sends queued notifications (call every minute from a cron/scheduler with the LOVABLE_CRON_SECRET bearer).
 * Safe to run concurrently: rows are claimed with SKIP LOCKED and leased, sends are idempotent, and
 * failures retry with backoff before dead-lettering.
 */
export const Route = createFileRoute("/api/public/notifications/dispatch")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authenticateCronRequest } = await import("@/integrations/supabase/cron-auth");
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;
        try {
          const { runNotificationDispatch } = await import("@/lib/notifications/dispatch.server");
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const [summary, expired] = await Promise.all([
            runNotificationDispatch(new URL(request.url).origin),
            supabaseAdmin.rpc("payments_expire_stale"),
          ]);
          return Response.json({ ok: true, ...summary, paymentsExpired: expired.data ?? 0 });
        } catch (err) {
          console.error("notification dispatch failed", err instanceof Error ? err.message : "error");
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
