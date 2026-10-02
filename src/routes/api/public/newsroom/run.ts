import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const bodySchema = z.object({
  publishedAt: z.string().datetime().optional(),
  /** "daily" = the 06:00 SAST schedule (one article, idempotent); "batch" = publish `count` (max 3) now, e.g. the launch backfill. */
  mode: z.enum(["daily", "batch", "single"]).optional(),
  count: z.number().int().min(1).max(3).optional(),
});

async function isAdminToken(request: Request): Promise<boolean> {
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.auth.getUser(token);
  if (!data.user) return false;
  const { data: role } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", data.user.id)
    .eq("role", "admin")
    .maybeSingle();
  return !!role;
}

export const Route = createFileRoute("/api/public/newsroom/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authenticateCronRequest } = await import("@/integrations/supabase/cron-auth");
        const cronDenied = await authenticateCronRequest(request);
        if (cronDenied && !(await isAdminToken(request))) {
          return new Response("Unauthorized", { status: 401 });
        }
        let body: z.infer<typeof bodySchema> = {};
        try {
          body = bodySchema.parse(await request.json().catch(() => ({})));
        } catch {
          return Response.json({ error: "Invalid body" }, { status: 400 });
        }
        try {
          const { runNewsroom } = await import("@/lib/newsroom.server");
          const mode =
            body.mode === "daily"
              ? ({ kind: "daily" } as const)
              : body.mode === "batch"
                ? ({ kind: "batch", count: body.count ?? 3 } as const)
                : ({
                    kind: "single",
                    ...(body.publishedAt ? { publishedAt: body.publishedAt } : {}),
                  } as const);
          const r = await runNewsroom(mode);
          const failed = r.published.length === 0 && r.errors.length > 0;
          return Response.json({ ok: !failed, ...r }, { status: failed ? 500 : 200 });
        } catch (error) {
          console.error("[newsroom] run failed", error);
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : "failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
