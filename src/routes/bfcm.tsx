import { canonical } from "@/lib/site";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CalendarDays, MapPin, ShieldCheck } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { BLACK_FRIDAY_NOTICE_ENDS } from "@/lib/events";

export const Route = createFileRoute("/bfcm")({
  // Campaign page: once the weekend is over (end of Mon 30 Nov 2026 SAST) it sends visitors home.
  beforeLoad: () => {
    if (Date.now() >= BLACK_FRIDAY_NOTICE_ENDS) throw redirect({ to: "/" });
  },
  head: () => ({
    links: canonical("/bfcm").links,
    meta: [
      ...canonical("/bfcm").meta,
      { title: "Black Friday weekend at Cannaplug | Pretoria Central" },
      {
        name: "description",
        content:
          "Cannaplug is an adults-only cannabis dispensary in Pretoria Central. Black Friday weekend, 27 to 30 November 2026. 18+ only.",
      },
    ],
  }),
  component: BfcmPage,
});

function BfcmPage() {
  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[760px] px-4 py-16 sm:px-6 lg:px-8">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
          Fri 27 – Mon 30 Nov 2026
        </p>
        <h1 className="font-display mt-2 text-3xl font-extrabold uppercase sm:text-5xl">
          Black Friday weekend at Cannaplug
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Cannaplug is an adults-only cannabis dispensary in Pretoria Central. This Black Friday
          weekend we are running offers in store and online, with online orders collected in store.
          In-store offers run Friday to Sunday; Monday 30 November is online only (collect in
          store).
        </p>

        <div className="bf-deals">
          <section>
            <h2>Visit us</h2>
            <p className="promo-meta mt-3">
              <MapPin size={14} aria-hidden="true" />
              Shop 002, One On Mutual, Pretoria Central
            </p>
            <p className="promo-meta">
              <CalendarDays size={14} aria-hidden="true" />
              Friday 27 – Monday 30 November 2026
            </p>
          </section>
          <section>
            <h2>18+ only</h2>
            <p className="promo-meta mt-3">
              <ShieldCheck size={14} aria-hidden="true" />
              You must be 18 or older. Bring your ID: we check it at collection.
            </p>
          </section>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link className="bf-cta" to="/events/black-friday">
            See this weekend&apos;s offers
          </Link>
          <Link className="bf-cta bf-cta-quiet" to="/">
            About Cannaplug
          </Link>
        </div>
        <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
          While stocks last. Not medical advice.
        </p>
      </main>
      <Footer />
    </div>
  );
}
