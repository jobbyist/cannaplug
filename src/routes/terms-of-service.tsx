import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout } from "@/components/LegalLayout";

export const Route = createFileRoute("/terms-of-service")({
  head: () => ({
    meta: [
      { title: "Terms of Service | CannaPlug" },
      {
        name: "description",
        content:
          "The terms and conditions governing your use of the CannaPlug website and services.",
      },
    ],
  }),
  component: TermsOfServicePage,
});

function TermsOfServicePage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Terms of Service"
      updated="23 September 2026"
      intro="These Terms of Service ('Terms') govern your access to and use of the CannaPlug website, mobile experience and dispensary services. By creating an account, placing an order or otherwise using CannaPlug, you agree to be bound by these Terms."
      sections={[
        {
          heading: "1. Who we are",
          body: (
            <>
              <p>
                CannaPlug (Registration No. 2026/047873/07) is a SAHPRA Section 21 authorised
                medical cannabis dispensary operating from Shop 002, One On Mutual, Pretoria
                Central, South Africa. References to "CannaPlug", "we", "us" or "our" mean CannaPlug
                and its operating entity.
              </p>
            </>
          ),
        },
        {
          heading: "2. Eligibility & age restriction",
          body: (
            <>
              <p>
                CannaPlug products are restricted to persons aged 18 years or older. By using our
                site or purchasing products, you confirm that you are at least 18 years old and that
                you are legally permitted to purchase and possess cannabis products under applicable
                South African law, including where relevant a valid medical prescription or
                practitioner recommendation.
              </p>
              <p>
                We reserve the right to request proof of age or medical authorisation at any point,
                including at the point of delivery or collection, and to refuse service where this
                cannot be verified.
              </p>
            </>
          ),
        },
        {
          heading: "3. Account registration",
          body: (
            <p>
              You are responsible for maintaining the confidentiality of your account credentials
              and for all activity that occurs under your account. Notify us immediately at{" "}
              <a
                className="font-semibold text-primary underline-offset-2 hover:underline"
                href="mailto:hello@cannaplug.co.za"
              >
                hello@cannaplug.co.za
              </a>{" "}
              if you suspect unauthorised use of your account.
            </p>
          ),
        },
        {
          heading: "4. Orders & product availability",
          body: (
            <>
              <p>
                All orders are subject to acceptance and availability. Product descriptions, strain
                profiles, cannabinoid percentages and imagery are provided for guidance only and may
                vary between batches. We make reasonable efforts to keep pricing and stock
                information accurate but do not guarantee that all details are error-free at all
                times.
              </p>
              <p>
                We reserve the right to limit order quantities, refuse or cancel an order, and to
                correct pricing errors, in each case at our discretion and, where an order has
                already been paid for, with a full refund of the affected amount.
              </p>
            </>
          ),
        },
        {
          heading: "5. Pricing & payment",
          body: (
            <p>
              All prices are listed in South African Rand (ZAR) and are inclusive of applicable
              taxes unless stated otherwise. Payment is processed at checkout via the payment
              methods made available on the site. You warrant that any payment information you
              provide is accurate and that you are authorised to use the chosen payment method.
            </p>
          ),
        },
        {
          heading: "6. Responsible use",
          body: (
            <p>
              Cannabis products carry health, safety and legal considerations. You agree to consume
              CannaPlug products responsibly, to store them safely away from children and pets, and
              not to operate a vehicle or machinery while under their influence. CannaPlug provides
              general education but does not provide medical advice — consult a qualified healthcare
              practitioner regarding your specific circumstances.
            </p>
          ),
        },
        {
          heading: "7. Intellectual property",
          body: (
            <p>
              All content on this site — including the CannaPlug name, logo, graphics, photography
              and copy — is owned by or licensed to CannaPlug and is protected by applicable
              intellectual property laws. You may not reproduce, distribute or create derivative
              works from this content without our prior written consent.
            </p>
          ),
        },
        {
          heading: "8. Limitation of liability",
          body: (
            <p>
              To the maximum extent permitted by law, CannaPlug is not liable for any indirect,
              incidental or consequential loss arising from your use of the site or our products.
              Nothing in these Terms limits liability that cannot be excluded under South African
              consumer protection law.
            </p>
          ),
        },
        {
          heading: "9. Changes to these Terms",
          body: (
            <p>
              We may update these Terms from time to time to reflect changes in our services or
              applicable regulation. The "Last updated" date above reflects the most recent
              revision. Continued use of the site after changes take effect constitutes acceptance
              of the revised Terms.
            </p>
          ),
        },
        {
          heading: "10. Governing law",
          body: (
            <p>
              These Terms are governed by the laws of the Republic of South Africa. Any disputes
              arising from these Terms or your use of CannaPlug will be subject to the exclusive
              jurisdiction of the South African courts.
            </p>
          ),
        },
      ]}
    />
  );
}
