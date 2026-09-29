import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled inventory housekeeping (call from a cron with the LOVABLE_CRON_SECRET bearer token):
 *   - expires overdue online-order stock holds (returns their quantity to available stock)
 *   - purges idempotency keys older than 30 days
 * Both operations are safe to run concurrently and repeatedly.
 */
export const Route = createFileRoute("/api/public/inventory/maintenance")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authenticateCronRequest } = await import("@/integrations/supabase/cron-auth");
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const [expired, purged] = await Promise.all([
          supabaseAdmin.rpc("release_expired_reservations"),
          supabaseAdmin.rpc("purge_old_idempotency_keys", {}),
        ]);
        if (expired.error || purged.error) {
          console.error(
            "inventory maintenance failed",
            expired.error?.message,
            purged.error?.message,
          );
          return Response.json({ ok: false }, { status: 500 });
        }
        return Response.json({ ok: true, expiredHolds: expired.data, purgedKeys: purged.data });
      },
    },
  },
});
