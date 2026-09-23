import { createFileRoute } from "@tanstack/react-router";
import { LegalLayout } from "@/components/LegalLayout";

export const Route = createFileRoute("/privacy-policy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy | CannaPlug" },
      {
        name: "description",
        content:
          "How CannaPlug collects, uses and protects your personal information, in line with South Africa's POPIA.",
      },
    ],
  }),
  component: PrivacyPolicyPage,
});

function PrivacyPolicyPage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Privacy Policy"
      updated="23 September 2026"
      intro="CannaPlug respects your privacy and is committed to protecting your personal information in accordance with the Protection of Personal Information Act (POPIA) and other applicable South African law. This policy explains what we collect, why, and how we keep it safe."
      sections={[
        {
          heading: "1. Information we collect",
          body: (
            <>
              <p>We collect information that you provide directly, including:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Account details — name, email address, phone number and password.</li>
                <li>
                  Order details — delivery address, order history and payment reference (we do not
                  store full card numbers).
                </li>
                <li>
                  Communications — messages you send via our contact form, chat widget or customer
                  support.
                </li>
                <li>
                  Where applicable, medical practitioner recommendation details required for
                  regulated purchases.
                </li>
              </ul>
              <p>
                We also automatically collect limited technical information — such as device type,
                browser and approximate location — via cookies and similar technologies, to keep the
                site secure and improve performance.
              </p>
            </>
          ),
        },
        {
          heading: "2. How we use your information",
          body: (
            <ul className="list-disc space-y-1 pl-5">
              <li>To process and fulfil your orders, including delivery and support.</li>
              <li>To verify age and, where required, medical eligibility to purchase.</li>
              <li>To manage your account, rewards balance and order history.</li>
              <li>To send order updates and, with your consent, marketing communications.</li>
              <li>To detect fraud, secure our systems and comply with legal obligations.</li>
            </ul>
          ),
        },
        {
          heading: "3. Legal basis for processing",
          body: (
            <p>
              We process your personal information where it is necessary to perform our contract
              with you (e.g. fulfilling an order), to comply with a legal obligation (e.g.
              regulatory record-keeping for cannabis sales), on the basis of your consent (e.g.
              marketing emails), or where we have a legitimate interest that is not overridden by
              your rights (e.g. fraud prevention).
            </p>
          ),
        },
        {
          heading: "4. Sharing your information",
          body: (
            <>
              <p>We do not sell your personal information. We may share it with:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Delivery and logistics partners, to fulfil your order.</li>
                <li>Payment processors, to complete transactions securely.</li>
                <li>
                  Regulatory bodies, where required by South African cannabis and health
                  legislation.
                </li>
                <li>
                  Service providers who support our platform (e.g. hosting, analytics) under
                  confidentiality obligations.
                </li>
              </ul>
            </>
          ),
        },
        {
          heading: "5. Data retention",
          body: (
            <p>
              We retain personal information for as long as necessary to fulfil the purposes
              outlined in this policy, including applicable statutory retention periods for
              regulated cannabis sales records, after which it is securely deleted or anonymised.
            </p>
          ),
        },
        {
          heading: "6. Security",
          body: (
            <p>
              We apply reasonable technical and organisational measures — including encryption in
              transit, access controls and regular security reviews — to protect your information
              against unauthorised access, loss or misuse.
            </p>
          ),
        },
        {
          heading: "7. Your rights",
          body: (
            <>
              <p>Under POPIA, you have the right to:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>Access the personal information we hold about you.</li>
                <li>Request correction or deletion of inaccurate or outdated information.</li>
                <li>Object to processing for direct marketing purposes.</li>
                <li>Withdraw consent where processing is based on consent.</li>
                <li>Lodge a complaint with the Information Regulator of South Africa.</li>
              </ul>
              <p>
                To exercise any of these rights, contact our Information Officer at{" "}
                <a
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                  href="mailto:hello@cannaplug.co.za"
                >
                  hello@cannaplug.co.za
                </a>
                .
              </p>
            </>
          ),
        },
        {
          heading: "8. Cookies",
          body: (
            <p>
              We use essential cookies to keep the site functional (including remembering items in
              your cart) and, with your consent, analytics cookies to understand site usage. You can
              control cookies through your browser settings at any time.
            </p>
          ),
        },
        {
          heading: "9. Changes to this policy",
          body: (
            <p>
              We may update this Privacy Policy periodically to reflect changes in our practices or
              legal requirements. Material changes will be communicated via the site or by email
              where appropriate.
            </p>
          ),
        },
      ]}
    />
  );
}
