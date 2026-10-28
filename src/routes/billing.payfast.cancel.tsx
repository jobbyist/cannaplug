import { createFileRoute } from "@tanstack/react-router";
import { BillingLanding } from "@/components/billing/BillingLanding";

export const Route = createFileRoute("/billing/payfast/cancel")({
  head: () => ({
    meta: [{ title: "Payfast payment | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: () => <BillingLanding service="payfast" kind="cancel" />,
});
