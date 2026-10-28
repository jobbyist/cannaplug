import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, Clock, X } from "lucide-react";
import cannaplugLogo from "@/assets/cannaplug-logo.png";
import { Button } from "@/components/ui/button";
import { BILLING_SERVICE_LABEL, type BillingService } from "@/lib/billing";

export type BillingLandingKind = "return" | "cancel" | "notify";

const LOGO: Record<BillingService, string> = {
  payfast: "/billing/payfast.png",
  verifynow: "/billing/verifynow.png",
};

const COPY: Record<BillingLandingKind, { title: string; body: (s: string) => string }> = {
  return: {
    title: "Thanks, we're confirming your payment",
    body: (s) =>
      `${s} will confirm the payment with Cannaplug shortly. It appears in the Billing tab once it's confirmed. Nothing on this page proves it was paid.`,
  },
  cancel: {
    title: "Payment cancelled",
    body: (s) =>
      `No payment was made to ${s}. You can try again from the Billing tab whenever you're ready.`,
  },
  notify: {
    title: "Payment notifications",
    body: (s) =>
      `This address receives payment notifications from ${s} through Payfast. There is nothing to do here.`,
  },
};

/** Landing page for a Payfast return, cancel or notify URL of a billed service. Shows no payment details. */
export function BillingLanding({
  service,
  kind,
}: {
  service: BillingService;
  kind: BillingLandingKind;
}) {
  const label = BILLING_SERVICE_LABEL[service];
  const copy = COPY[kind];
  const Icon = kind === "return" ? Clock : kind === "cancel" ? X : Check;
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <main className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8">
        <img src={cannaplugLogo} alt="Cannaplug" className="mx-auto mb-6 h-7 w-auto" />
        <div className="mx-auto mb-5 grid h-20 w-44 place-items-center rounded-xl border border-border bg-white p-3">
          <img src={LOGO[service]} alt={label} className="max-h-14 max-w-36 object-contain" />
        </div>
        <span
          aria-hidden
          className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary"
        >
          <Icon size={20} />
        </span>
        <h1 className="font-display text-lg font-extrabold uppercase">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{copy.body(label)}</p>
        <Button asChild className="mt-6">
          <Link to="/admin" hash="billing">
            <ArrowLeft size={16} /> Back to admin area
          </Link>
        </Button>
      </main>
    </div>
  );
}
