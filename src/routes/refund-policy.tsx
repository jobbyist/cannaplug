import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout } from "@/components/LegalLayout";

export const Route = createFileRoute("/refund-policy")({
  head: () => ({
    meta: [
      { title: "Refund Policy | CannaPlug" },
      {
        name: "description",
        content:
          "CannaPlug's policy on refunds, cancellations and returns for cannabis products and accessories.",
      },
    ],
  }),
  component: RefundPolicyPage,
});

function RefundPolicyPage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Refund Policy"
      updated="23 September 2026"
      intro="Because cannabis products are consumable, regulated goods, our refund policy differs from typical retail returns. This page explains when a refund, replacement or credit applies."
      sections={[
        {
          heading: "1. Order cancellations",
          body: (
            <p>
              You may cancel an order free of charge at any time before it has been dispatched or
              prepared for collection. Once an order has entered fulfilment, it can no longer be
              cancelled, but the situations below may still qualify for a refund or replacement.
            </p>
          ),
        },
        {
          heading: "2. Faulty, damaged or incorrect items",
          body: (
            <>
              <p>You are entitled to a replacement, refund or store credit where:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>The item received is damaged, defective or does not match its listing.</li>
                <li>You received the wrong product or an incorrect quantity.</li>
                <li>A product fails to meet the quality or lab-testing standard advertised.</li>
              </ul>
              <p>
                Report the issue within 48 hours of delivery with your order number and, where
                possible, photos of the product and packaging, to{" "}
                <a
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                  href="mailto:hello@cannaplug.co.za"
                >
                  hello@cannaplug.co.za
                </a>
                . We will investigate and resolve valid claims promptly.
              </p>
            </>
          ),
        },
        {
          heading: "3. Change of mind",
          body: (
            <p>
              Due to the consumable and regulated nature of cannabis flower, edibles, vapes and
              concentrates, we are unable to accept change-of-mind returns on opened or used
              products. Unopened, unused accessories in original packaging may be returned within 7
              days of delivery for a store credit or exchange.
            </p>
          ),
        },
        {
          heading: "4. Non-refundable items",
          body: (
            <p>
              For hygiene, safety and regulatory reasons, opened flower, edibles, vapes,
              concentrates and any product where the seal has been broken cannot be returned or
              refunded unless found to be faulty or non-compliant on arrival.
            </p>
          ),
        },
        {
          heading: "5. How refunds are processed",
          body: (
            <p>
              Approved refunds are issued to the original payment method within 5–10 business days.
              Where a refund isn't possible on the original method, we will offer an equivalent
              store credit or EFT refund, at your preference.
            </p>
          ),
        },
        {
          heading: "6. Delivery-related issues",
          body: (
            <p>
              If your order does not arrive, or arrives significantly later than the delivery window
              provided at checkout, contact our support team and we will investigate with our
              delivery partner and offer a refund or reshipment where appropriate.
            </p>
          ),
        },
        {
          heading: "7. Contact us",
          body: (
            <p>
              For any refund, return or cancellation query, reach our support team at{" "}
              <a
                className="font-semibold text-primary underline-offset-2 hover:underline"
                href="mailto:hello@cannaplug.co.za"
              >
                hello@cannaplug.co.za
              </a>{" "}
              or +27 10 123 4567, Mon–Fri 09:00–19:00, Sat 09:00–20:00, Sun 09:00–15:00.
            </p>
          ),
        },
      ]}
    />
  );
}
