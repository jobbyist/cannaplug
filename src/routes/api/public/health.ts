import { createFileRoute } from "@tanstack/react-router";

/**
 * /api/public/health for an uptime checker: is the database reachable, and is the notification queue moving?
 * Counts only; no data, no secrets. 200 when the database answers, 503 when it does not.
 */
export const Route = createFileRoute("/api/public/health")({
  server: {
    handlers: {
      GET: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const started = Date.now();
        const headers = { "content-type": "application/json", "cache-control": "no-store" };
        try {
          const db = await supabaseAdmin
            .from("products")
            .select("id", { head: true, count: "exact" })
            .limit(1);
          if (db.error) throw new Error("db");
          const stuckBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
          const [due, stuck, failed] = await Promise.all([
            supabaseAdmin
              .from("notification_events")
              .select("id", { head: true, count: "exact" })
              .eq("status", "queued")
              .lte("next_attempt_at", new Date().toISOString()),
            supabaseAdmin
              .from("notification_events")
              .select("id", { head: true, count: "exact" })
              .in("status", ["queued", "failed"])
              .lte("next_attempt_at", stuckBefore),
            supabaseAdmin
              .from("notification_events")
              .select("id", { head: true, count: "exact" })
              .eq("status", "dead"),
          ]);
          const queue = {
            due: due.count ?? null,
            stuck_15m: stuck.count ?? null,
            dead: failed.count ?? null,
          };
          return new Response(
            JSON.stringify({
              status: (queue.stuck_15m ?? 0) > 0 ? "degraded" : "ok",
              db: "ok",
              queue,
              ms: Date.now() - started,
            }),
            { status: 200, headers },
          );
        } catch {
          return new Response(
            JSON.stringify({ status: "down", db: "unreachable", ms: Date.now() - started }),
            {
              status: 503,
              headers,
            },
          );
        }
      },
    },
  },
});
