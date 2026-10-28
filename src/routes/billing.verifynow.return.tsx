import { createFileRoute } from "@tanstack/react-router";
import { BillingLanding } from "@/components/billing/BillingLanding";

export const Route = createFileRoute("/billing/verifynow/return")({
  head: () => ({
    meta: [{ title: "VerifyNow payment | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: () => <BillingLanding service="verifynow" kind="return" />,
});
