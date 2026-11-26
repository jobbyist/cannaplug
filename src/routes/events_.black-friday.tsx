import { canonical } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays, MapPin } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { BLACK_FRIDAY_PATH, EVENTS_AND_PROMOTIONS, BLACK_FRIDAY_SLUG } from "@/lib/events";

export const Route = createFileRoute("/events_/black-friday")({
  head: () => ({
    links: canonical(BLACK_FRIDAY_PATH).links,
    meta: [
      ...canonical(BLACK_FRIDAY_PATH).meta,
      { title: "Black Friday + Cyber Monday | CannaPlug" },
      {
        name: "description",
        content:
          "CannaPlug Black Friday and Cyber Monday, 27 to 30 November 2026: in-store deals, online-only prices, double loyalty points and Double Plug Back.",
      },
    ],
  }),
  component: BlackFridayPost,
});

const IN_STORE = [
  ["Top Shelf flower", "25% off (R90/g instead of R120)"],
  ["Greenhouse pre-rolls", "Buy 2, get the 3rd free"],
  ["Double Plug Back", "5 empty tubes = 1 free pre-roll"],
  ["All accessories", "20% off: grinders, papers, trays and more"],
] as const;

const ONLINE = [
  ["Entry Indoor flower", "R70/g online price (was R100)"],
  ["All edibles", "20% off. Order online, collect in store"],
  ["Double loyalty points", "On every collect-in-store order"],
  ["Cyber Monday only", "Greendoor flower R55/g (was R70)"],
] as const;

function BlackFridayPost() {
  const post = EVENTS_AND_PROMOTIONS.find((e) => e.slug === BLACK_FRIDAY_SLUG);
  if (!post) return null;
  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[880px] px-4 py-16 sm:px-6 lg:px-8">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
          {post.kind} · {post.tag}
        </p>
        <h1 className="font-display mt-2 text-3xl font-extrabold uppercase sm:text-5xl">
          {post.title}
        </h1>
        <p className="promo-meta mt-3">
          <CalendarDays size={14} aria-hidden="true" />
          {post.when}
        </p>
        <p className="promo-meta">
          <MapPin size={14} aria-hidden="true" />
          Shop 002, One On Mutual, Pretoria Central
        </p>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
          In-store deals all weekend, online-only prices to order and collect, double loyalty points
          on online orders and Double Plug Back. While stocks last.
        </p>

        <div className="bf-posters">
          {post.posters?.map((p) => (
            <img
              key={p.image}
              src={p.image}
              alt={p.alt}
              width={p.width}
              height={p.height}
              loading="lazy"
            />
          ))}
        </div>

        <div className="bf-deals">
          <section>
            <h2>In store · Fri 27 – Sun 29 Nov</h2>
            <ul>
              {IN_STORE.map(([name, deal]) => (
                <li key={name}>
                  <b>{name}</b>
                  <span>{deal}</span>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Online only · collect in store · to Mon 30 Nov</h2>
            <ul>
              {ONLINE.map(([name, deal]) => (
                <li key={name}>
                  <b>{name}</b>
                  <span>{deal}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
          Online orders are collected in store: bring your ID, we check it on collection. 18+
          verified members only. While stocks last. Not medical advice.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a className="bf-cta" href="/shop?sale=true">
            Shop the specials
          </a>
          <a className="bf-cta bf-cta-quiet" href="/events">
            All events & promotions
          </a>
        </div>
      </main>
      <Footer />
    </div>
  );
}
