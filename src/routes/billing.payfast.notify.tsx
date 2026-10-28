import { createFileRoute } from "@tanstack/react-router";
import { BillingLanding } from "@/components/billing/BillingLanding";

/**
 * Payfast notify URL for Payfast payments. GET shows a landing page; POST is Payfast's notification, which is
 * verified (signature, Payfast source address, Payfast's validate call) before the payment is logged.
 */
export const Route = createFileRoute("/billing/payfast/notify")({
  head: () => ({
    meta: [{ title: "Payfast payment | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: () => <BillingLanding service="payfast" kind="notify" />,
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { processBillingNotify } = await import("@/lib/billing/payfast-notify.server");
        const raw = await request.text();
        const ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          request.headers.get("x-real-ip")?.trim() ??
          null;
        try {
          const r = await processBillingNotify("payfast", raw, request.headers, ip);
          return new Response(r.body, { status: r.status });
        } catch (err) {
          console.error(
            "billing notify processing failed",
            err instanceof Error ? err.message : "error",
          );
          return new Response("error", { status: 500 }); // Payfast resends; replay is safe
        }
      },
    },
  },
});
