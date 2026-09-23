import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout } from "@/components/LegalLayout";

export const Route = createFileRoute("/delivery-policy")({
  head: () => ({
    meta: [
      { title: "Delivery Policy | CannaPlug" },
      {
        name: "description",
        content:
          "Delivery areas, timelines, fees and discreet packaging information for CannaPlug orders.",
      },
    ],
  }),
  component: DeliveryPolicyPage,
});

function DeliveryPolicyPage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Delivery Policy"
      updated="23 September 2026"
      intro="We aim to get your order to you quickly, discreetly and safely. This page covers delivery areas, timelines, fees, age verification and what happens if something goes wrong."
      sections={[
        {
          heading: "1. Delivery areas",
          body: (
            <p>
              CannaPlug currently delivers across Pretoria, Johannesburg and Cape Town metro areas,
              with in-store collection available at Shop 002, One On Mutual, Pretoria Central. Enter
              your address at checkout to confirm delivery availability for your area.
            </p>
          ),
        },
        {
          heading: "2. Delivery options & timelines",
          body: (
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b className="text-foreground">Standard delivery</b> — 2–3 working days, R80.
              </li>
              <li>
                <b className="text-foreground">Discreet delivery</b> — plain, unbranded packaging
                handed directly to you, R120.
              </li>
              <li>
                <b className="text-foreground">In-store collection</b> — free, ready within 2 hours
                during trading hours.
              </li>
            </ul>
          ),
        },
        {
          heading: "3. Discreet, compliant packaging",
          body: (
            <p>
              Every order is packed in plain, tamper-evident packaging with no external branding
              indicating the contents. This protects your privacy and meets regulatory requirements
              for the transport of cannabis products.
            </p>
          ),
        },
        {
          heading: "4. Age & ID verification",
          body: (
            <p>
              All deliveries require an age and identity check on handover. The recipient must be 18
              years or older and present valid government-issued photo ID. Where a medical
              recommendation is required for a product, this may also be verified at the door. We
              are unable to leave orders unattended or with a third party who cannot be verified.
            </p>
          ),
        },
        {
          heading: "5. Delivery fees & free delivery thresholds",
          body: (
            <p>
              Delivery fees are calculated at checkout based on your selected option and location.
              From time to time we may offer free or discounted delivery above a minimum order value
              — any active threshold will be shown at checkout.
            </p>
          ),
        },
        {
          heading: "6. Missed or failed deliveries",
          body: (
            <p>
              If nobody eligible is available to receive and verify the order, our courier will
              attempt to contact you to reschedule. Repeated failed deliveries may incur an
              additional redelivery fee. Orders that cannot be delivered after reasonable attempts
              will be returned to CannaPlug and refunded, less any delivery fees already incurred.
            </p>
          ),
        },
        {
          heading: "7. Order tracking",
          body: (
            <p>
              Once dispatched, you'll receive tracking details by email and can follow your order's
              status from the Orders tab in your CannaPlug account.
            </p>
          ),
        },
        {
          heading: "8. Delivery issues",
          body: (
            <p>
              For delayed, missing or damaged deliveries, contact our team at{" "}
              <a
                className="font-semibold text-primary underline-offset-2 hover:underline"
                href="mailto:hello@cannaplug.co.za"
              >
                hello@cannaplug.co.za
              </a>{" "}
              or +27 10 123 4567 and we'll resolve it as quickly as possible — see our{" "}
              <a
                className="font-semibold text-primary underline-offset-2 hover:underline"
                href="/refund-policy"
              >
                Refund Policy
              </a>{" "}
              for further detail.
            </p>
          ),
        },
      ]}
    />
  );
}
