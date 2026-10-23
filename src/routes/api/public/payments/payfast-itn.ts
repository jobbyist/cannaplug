import { createFileRoute } from "@tanstack/react-router";

/**
 * PayFast ITN (Instant Transaction Notification). The raw form body is read once and put through PayFast's
 * security checks — signature, PayFast source address, and PayFast's own validation endpoint — BEFORE any
 * business logic. Only then does the database compare the verified amount / merchant / transaction with
 * what it expected and apply it idempotently. Responses never describe why a message was refused.
 */
export const Route = createFileRoute("/api/public/payments/payfast-itn")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ handleWebhook }, { paymentsDeps, hashIp }] = await Promise.all([
          import("@/lib/payments/service"),
          import("@/lib/payments/service.server"),
        ]);
        const raw = await request.text();
        const ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          request.headers.get("x-real-ip")?.trim() ??
          null;
        try {
          const r = await handleWebhook(
            paymentsDeps(new URL(request.url).origin),
            "payfast",
            raw,
            request.headers,
            hashIp(ip),
            ip,
          );
          return new Response(r.body, { status: r.status });
        } catch (err) {
          console.error(
            "payfast itn processing failed",
            err instanceof Error ? err.message : "error",
          );
          return new Response("error", { status: 500 }); // PayFast resends; replay is safe
        }
      },
    },
  },
});
