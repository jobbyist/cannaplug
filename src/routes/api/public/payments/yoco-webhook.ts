import { createFileRoute } from "@tanstack/react-router";

/**
 * yoco payment notifications. The raw body is read once, verified against the provider's current signature
 * scheme BEFORE any business logic, and only then handed to the database, which compares the verified
 * facts to the expected amount/currency/merchant/reference and applies them idempotently.
 * Responses never describe why a message was refused.
 */
export const Route = createFileRoute("/api/public/payments/yoco-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const [{ handleWebhook }, { paymentsDeps, hashIp }] = await Promise.all([
          import("@/lib/payments/service"),
          import("@/lib/payments/service.server"),
        ]);
        const raw = await request.text();
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        try {
          const r = await handleWebhook(paymentsDeps(new URL(request.url).origin), "yoco", raw, request.headers, hashIp(ip));
          return new Response(r.body, { status: r.status });
        } catch (err) {
          console.error("yoco webhook processing failed", err instanceof Error ? err.message : "error");
          return new Response("error", { status: 500 }); // provider will redeliver; replay is safe
        }
      },
    },
  },
});
