import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BadgeCheck,
  HeartHandshake,
  Leaf,
  MapPin,
  ShieldCheck,
  Sparkles,
  Users2,
} from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import heroImage from "@/assets/cannaplug-hero.jpg";
import editorialImage from "@/assets/cannaplug-editorial.jpg";
import badgeImage from "@/assets/cannaplug-badge.png";
import storeAsset from "@/assets/cannaplug-storefront.jpg.asset.json";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About CannaPlug | Pioneering Medical Cannabis in South Africa" },
      {
        name: "description",
        content:
          "CannaPlug is one of South Africa's few SAHPRA-authorised medical cannabis dispensaries, working to legitimise the market and champion South African cannabis culture.",
      },
      { property: "og:title", content: "About CannaPlug" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: AboutPage,
});

const PILLARS = [
  {
    icon: ShieldCheck,
    title: "SAHPRA authorised",
    copy: "One of the few dispensaries in South Africa holding Section 21 SAHPRA authorisation — every product lab tested, every process compliant.",
  },
  {
    icon: Sparkles,
    title: "Legitimising the market",
    copy: "We're building the systems, standards and trust that a historically unregulated market has lacked — for patients, consumers and the industry alike.",
  },
  {
    icon: HeartHandshake,
    title: "Education over hype",
    copy: "Real advice from knowledgeable people, without judgement — so every customer can make an informed, confident choice.",
  },
  {
    icon: Users2,
    title: "Culture, not just commerce",
    copy: "We champion the people, artists and communities shaping a positive, proud cannabis culture across South Africa.",
  },
];

const TIMELINE = [
  {
    year: "The problem",
    copy: "For decades, South Africa's cannabis market operated in the shadows — inconsistent quality, no accountability, and real stigma.",
  },
  {
    year: "The opening",
    copy: "SAHPRA authorisation created a legal path for medical cannabis dispensaries to operate transparently and safely.",
  },
  {
    year: "CannaPlug",
    copy: "We became one of the first dispensaries to take that path — pairing pharmaceutical-grade compliance with genuine cannabis culture.",
  },
  {
    year: "Today",
    copy: "A trusted Pretoria dispensary serving a growing national community, and a reference point for what a legitimate market can look like.",
  },
];

function AboutPage() {
  return (
    <div className="site">
      <Header />
      <main>
        <section className="relative overflow-hidden">
          <img
            src={heroImage}
            alt="Premium cannabis flower curated by CannaPlug"
            className="h-[52vh] min-h-[380px] w-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-charcoal via-charcoal/50 to-charcoal/10" />
          <div className="absolute inset-0 flex flex-col justify-end px-4 pb-10 sm:px-6 lg:px-10">
            <div className="mx-auto w-full max-w-[1180px] text-primary-foreground">
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.2em] text-sage">
                Our story
              </p>
              <h1 className="mt-2 max-w-2xl font-display text-3xl font-extrabold uppercase leading-[1.05] sm:text-5xl">
                Pioneering medical cannabis, the right way.
              </h1>
              <p className="mt-4 max-w-xl text-sm text-primary-foreground/85 sm:text-base">
                CannaPlug is one of a select few SAHPRA-authorised dispensaries in South Africa —
                built to legitimise a historically unregulated market and champion the culture
                behind it.
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1180px] px-4 py-16 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
                Who we are
              </p>
              <h2 className="mt-2 font-display text-2xl font-extrabold uppercase sm:text-3xl">
                Good plants. Great people. A legitimate industry.
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                CannaPlug was founded to answer a simple question: what would South African cannabis
                look like if it were done properly? Not grey-market, not guesswork — but lab-tested,
                accountable and proudly local.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                As one of the country's few dispensaries operating under SAHPRA Section 21
                authorisation, we sit at the intersection of pharmaceutical-grade compliance and
                genuine cannabis culture. Every product on our shelves is sourced, tested and
                documented to a standard the wider market has long needed — and every customer who
                walks through our door, in Pretoria or online, gets real, judgement-free guidance.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                We believe legitimising the industry isn't just about paperwork. It's about proving,
                every day, that cannabis in South Africa can be professional, safe and something to
                be proud of — while celebrating the creativity, community and positive culture that
                has always surrounded the plant.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link to="/shop">
                  <Button>
                    Shop the range <ArrowRight size={15} />
                  </Button>
                </Link>
                <Link to="/faq">
                  <Button variant="outline">Read our FAQs</Button>
                </Link>
              </div>
            </div>
            <div className="relative overflow-hidden rounded-2xl">
              <img
                src={editorialImage}
                alt="Inside the CannaPlug dispensary experience"
                className="h-full w-full object-cover"
              />
            </div>
          </div>
        </section>

        <section className="bg-secondary/50 py-16">
          <div className="mx-auto w-full max-w-[1180px] px-4 sm:px-6 lg:px-8">
            <div className="mb-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
                  What we stand for
                </p>
                <h2 className="mt-2 font-display text-2xl font-extrabold uppercase sm:text-3xl">
                  Built on four pillars
                </h2>
              </div>
              <img
                src={badgeImage}
                alt="CannaPlug SAHPRA authorised dispensary badge"
                className="h-16 w-auto"
              />
            </div>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {PILLARS.map((pillar) => (
                <div key={pillar.title} className="rounded-xl border border-border bg-card p-5">
                  <pillar.icon className="text-primary" size={26} />
                  <h3 className="mt-3 font-display text-sm font-bold uppercase">{pillar.title}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {pillar.copy}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1180px] px-4 py-16 sm:px-6 lg:px-8">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
            From the shadows to the shelf
          </p>
          <h2 className="mt-2 max-w-xl font-display text-2xl font-extrabold uppercase sm:text-3xl">
            Legitimising South African cannabis
          </h2>
          <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {TIMELINE.map((step) => (
              <div key={step.year} className="rounded-xl border-l-2 border-primary pl-4">
                <p className="font-display text-xs font-bold uppercase tracking-wide text-primary">
                  {step.year}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{step.copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1180px] px-4 pb-16 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-6 overflow-hidden rounded-2xl bg-primary text-primary-foreground lg:grid-cols-[1.2fr_1fr]">
            <div className="relative flex flex-col justify-center gap-4 p-8 sm:p-10">
              <img
                src={storeAsset.url}
                alt=""
                className="absolute inset-0 h-full w-full object-cover opacity-20"
              />
              <div className="relative">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-sage">Visit us</p>
                <h2 className="font-display text-2xl font-extrabold uppercase leading-tight sm:text-3xl">
                  Come see what a legitimate dispensary looks like.
                </h2>
                <p className="mt-3 flex items-center gap-2 text-sm text-primary-foreground/85">
                  <MapPin size={16} /> Shop 002, One On Mutual, Pretoria Central
                </p>
                <p className="mt-1 flex items-center gap-2 text-sm text-primary-foreground/85">
                  <BadgeCheck size={16} /> SAHPRA Section 21 Authorised · Reg. No. 2026/047873/07
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                  <Link to="/shop">
                    <Button variant="gold">
                      Shop now <ArrowRight size={15} />
                    </Button>
                  </Link>
                  <a href="/#contact">
                    <Button
                      variant="outline"
                      className="bg-transparent border-primary-foreground text-primary-foreground hover:bg-primary-foreground hover:text-primary"
                    >
                      Get directions
                    </Button>
                  </a>
                </div>
              </div>
            </div>
            <div className="flex flex-col justify-center gap-3 p-8 sm:p-10">
              <Leaf className="text-sage" size={28} />
              <p className="font-display text-lg font-bold uppercase leading-snug">
                Quality cannabis. Real people. A better industry for South Africa.
              </p>
              <p className="text-sm text-primary-foreground/80">
                Every visit, every order and every conversation is part of building a cannabis
                culture South Africa can be proud of.
              </p>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
