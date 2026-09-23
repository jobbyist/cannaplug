import { createFileRoute, Link } from "@tanstack/react-router";
import { Headphones, Mail, Phone } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export const Route = createFileRoute("/faq")({
  head: () => ({
    meta: [
      { title: "FAQs | CannaPlug" },
      {
        name: "description",
        content:
          "Answers to common questions about ordering, delivery, SAHPRA compliance and account management at CannaPlug.",
      },
    ],
  }),
  component: FaqPage,
});

type FaqGroup = {
  category: string;
  items: { question: string; answer: string }[];
};

const FAQ_GROUPS: FaqGroup[] = [
  {
    category: "Ordering & products",
    items: [
      {
        question: "Do I need a prescription to buy from CannaPlug?",
        answer:
          "CannaPlug operates as a SAHPRA-authorised dispensary. Some products can be purchased by verified adults 18+, while others require a valid medical practitioner recommendation. Any product that requires authorisation will be clearly marked, and our team can guide you through the process.",
      },
      {
        question: "Are CannaPlug products lab tested?",
        answer:
          "Yes. Every batch we stock is lab tested for cannabinoid content, potency and contaminants before it reaches our shelves, so you always know exactly what you're getting.",
      },
      {
        question: "How do I know which strain or product is right for me?",
        answer:
          "Our in-store and chat team can walk you through strain types (Indica, Sativa, Hybrid), potency and consumption methods based on what you're looking for. You can also browse the Shop page and filter by category, strain type and price to compare options.",
      },
      {
        question: "Can I edit or cancel my order after placing it?",
        answer:
          "You can cancel or adjust an order free of charge any time before it is prepared for delivery or collection. Once fulfilment has started, changes may not be possible — see our Refund Policy for details.",
      },
    ],
  },
  {
    category: "Delivery & collection",
    items: [
      {
        question: "Where does CannaPlug deliver?",
        answer:
          "We currently deliver across the Pretoria, Johannesburg and Cape Town metro areas, with free in-store collection available at Shop 002, One On Mutual, Pretoria Central. Enter your address at checkout to confirm availability.",
      },
      {
        question: "How long does delivery take?",
        answer:
          "Standard delivery takes 2–3 working days. Discreet delivery, with plain unbranded packaging handed directly to you, is also available. Full details are on our Delivery Policy page.",
      },
      {
        question: "Is my order delivered discreetly?",
        answer:
          "Always. Every order ships in plain, tamper-evident packaging with no external branding, and requires ID verification from an adult 18+ on handover.",
      },
    ],
  },
  {
    category: "Account & rewards",
    items: [
      {
        question: "Do I need an account to shop?",
        answer:
          "You can browse the shop without an account, but you'll need to sign in to complete checkout, track orders and earn Rewards points.",
      },
      {
        question: "How does the CannaPlug Rewards programme work?",
        answer:
          "You earn 1 point for every R10 spent. Points can be redeemed for products and exclusive drops — track your balance any time from your Account dashboard.",
      },
      {
        question: "I forgot my password — what do I do?",
        answer:
          "Head to the sign-in screen on the Account page and use the 'Forgot password?' link to reset it securely by email.",
      },
    ],
  },
  {
    category: "Compliance & responsible use",
    items: [
      {
        question: "Is CannaPlug a licensed dispensary?",
        answer:
          "Yes. CannaPlug is a SAHPRA Section 21 authorised medical cannabis dispensary, Registration No. 2026/047873/07, operating in full compliance with South African cannabis regulation.",
      },
      {
        question: "What is the minimum age to purchase from CannaPlug?",
        answer:
          "You must be 18 years or older to create an account, place an order, or collect/receive a delivery. Valid photo ID is required and may be checked at any point.",
      },
      {
        question: "How should I store cannabis products safely?",
        answer:
          "Store all products in their original packaging, out of reach of children and pets, away from direct sunlight and heat. Never operate a vehicle or machinery under the influence.",
      },
    ],
  },
];

function FaqPage() {
  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[900px] px-4 py-14 sm:px-6 lg:px-8">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">Support</p>
        <h1 className="mt-2 font-display text-3xl font-extrabold uppercase sm:text-4xl">
          Frequently asked questions
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Everything you need to know about shopping, delivery and your account. Can't find what
          you're looking for? Our team is a message away.
        </p>

        <div className="mt-10 flex flex-col gap-10">
          {FAQ_GROUPS.map((group) => (
            <section key={group.category}>
              <h2 className="mb-2 font-display text-sm font-bold uppercase tracking-wide text-foreground">
                {group.category}
              </h2>
              <Accordion
                type="single"
                collapsible
                className="rounded-xl border border-border bg-card px-5"
              >
                {group.items.map((item, index) => (
                  <AccordionItem key={item.question} value={`${group.category}-${index}`}>
                    <AccordionTrigger className="text-left text-sm font-semibold">
                      {item.question}
                    </AccordionTrigger>
                    <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                      {item.answer}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </section>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-primary text-primary-foreground">
              <Headphones size={20} />
            </span>
            <div>
              <p className="text-sm font-bold">Still have questions?</p>
              <p className="text-xs text-muted-foreground">
                Our team is here Mon–Fri 09:00–19:00, Sat 09:00–20:00, Sun 09:00–15:00.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-xs font-semibold">
            <a
              className="flex items-center gap-2 text-primary hover:underline"
              href="mailto:hello@cannaplug.co.za"
            >
              <Mail size={14} /> hello@cannaplug.co.za
            </a>
            <a
              className="flex items-center gap-2 text-primary hover:underline"
              href="tel:+27101234567"
            >
              <Phone size={14} /> +27 10 123 4567
            </a>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Prefer to browse?{" "}
          <Link
            to="/shop"
            className="font-semibold text-primary underline-offset-2 hover:underline"
          >
            Visit the shop
          </Link>
        </p>
      </main>
      <Footer />
    </div>
  );
}
