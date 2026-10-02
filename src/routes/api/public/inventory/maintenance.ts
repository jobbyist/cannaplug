import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled inventory housekeeping (call from a cron with the LOVABLE_CRON_SECRET bearer token):
 *   - expires overdue online-order stock holds (returns their quantity to available stock)
 *   - purges idempotency keys older than 30 days
 *   - credits loyalty for committed sales whose post-commit accrual failed (idempotent retry)
 *   - marks issued clinical documents past their expiry date as EXPIRED (verification does not depend on it)
 *   - removes ID images whose member account no longer exists (ID images live as long as the account)
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
        const [expired, purged, loyalty, clinical] = await Promise.all([
          supabaseAdmin.rpc("release_expired_reservations"),
          supabaseAdmin.rpc("purge_old_idempotency_keys", {}),
          supabaseAdmin.rpc("accrue_missing_pos_loyalty", {}),
          supabaseAdmin.rpc("clinical_document_expire_due"),
        ]);
        if (expired.error || purged.error || loyalty.error || clinical.error) {
          console.error(
            "inventory maintenance failed",
            expired.error?.message,
            purged.error?.message,
            loyalty.error?.message,
            clinical.error?.message,
          );
          return Response.json({ ok: false }, { status: 500 });
        }
        // Best-effort and separate: a storage hiccup must not fail the inventory jobs above.
        let idSweep: { scanned: number; removedFolders: number; removedFiles: number } | null =
          null;
        try {
          const { sweepOrphanedIdDocuments } = await import("@/lib/verification-data.server");
          idSweep = await sweepOrphanedIdDocuments();
        } catch (err) {
          console.error("ID document sweep failed", err instanceof Error ? err.message : err);
        }
        // Best-effort email automations (back in stock, ID expiring, low stock, weekly digest).
        let automations: unknown = null;
        try {
          const a = await supabaseAdmin.rpc("email_automations_run");
          automations = a.error ? { error: a.error.message } : a.data;
        } catch (err) {
          console.error("email automations failed", err instanceof Error ? err.message : err);
        }
        // Best-effort housekeeping: drop expired AI-quota counters.
        await supabaseAdmin.rpc("ai_quota_purge").then(undefined, () => undefined);
        // Also best-effort: expire abandoned payment attempts and flush the notification queue.
        let notifications: unknown = null;
        try {
          const [{ runNotificationDispatch }, stale] = await Promise.all([
            import("@/lib/notifications/dispatch.server"),
            supabaseAdmin.rpc("payments_expire_stale"),
          ]);
          notifications = {
            ...(await runNotificationDispatch(new URL(request.url).origin)),
            paymentsExpired: stale.data ?? 0,
          };
        } catch (err) {
          console.error("notification dispatch failed", err instanceof Error ? err.message : err);
        }
        return Response.json({
          ok: true,
          notifications,
          emailAutomations: automations,
          idDocumentSweep: idSweep,
          expiredHolds: expired.data,
          purgedKeys: purged.data,
          loyaltyRetried: loyalty.data,
          clinicalDocumentsExpired: clinical.data,
        });
      },
    },
  },
});
