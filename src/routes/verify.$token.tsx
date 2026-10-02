import { createFileRoute } from "@tanstack/react-router";
import { verifyDocumentFn } from "@/lib/clinical/verify.functions";
import { VerificationResult, VerificationShell } from "@/components/clinical/VerificationResult";

/**
 * Public document verification (the QR code lands here). It answers only "is this a genuine, current
 * CannaPlug document?" and shows the minimum needed to establish that — never the member's name,
 * diagnosis, medicines, dosage, address, ID number or any other health information.
 */
export const Route = createFileRoute("/verify/$token")({
  head: () => ({
    meta: [
      { title: "Document verification | CannaPlug" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  loader: ({ params }) => verifyDocumentFn({ data: { token: params.token } }),
  errorComponent: () => (
    <VerificationShell
      tone="warn"
      title="VERIFICATION UNAVAILABLE"
      lead="We couldn't check this document right now. Please try again shortly."
    />
  ),
  component: VerifyPage,
});

function VerifyPage() {
  return <VerificationResult result={Route.useLoaderData()} />;
}
