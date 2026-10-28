import { canonical } from "@/lib/site";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays, MapPin } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { EVENTS_AND_PROMOTIONS } from "@/lib/events";

export const Route = createFileRoute("/events")({
  head: () => ({
    links: canonical("/events").links,
    meta: [
      ...canonical("/events").meta,
      { title: "Events & Promotions | CannaPlug" },
      {
        name: "description",
        content:
          "CannaPlug events and promotions: Propaganda x 25K The Plug, the R70 Weekend Special and Halloweed Trick or Treat.",
      },
    ],
  }),
  component: EventsPage,
});

function EventsPage() {
  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[1180px] px-4 py-16 sm:px-6 lg:px-8">
        <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
          Good vibes & great people
        </p>
        <h1 className="font-display mt-2 text-3xl font-extrabold uppercase sm:text-5xl">
          Events & Promotions
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          What is happening at CannaPlug: events we host and the specials running in store.
        </p>
        <div className="promo-grid">
          {EVENTS_AND_PROMOTIONS.map((item) => (
            <article className="promo-card" key={item.slug} id={item.slug}>
              <img
                src={item.image}
                alt={item.imageAlt}
                width={item.width}
                height={item.height}
                loading="lazy"
              />
              <div className="promo-body">
                <p className="promo-tag">
                  {item.kind} · {item.tag}
                </p>
                <h2>{item.title}</h2>
                <p className="promo-meta">
                  <CalendarDays size={14} aria-hidden="true" />
                  {item.when}
                </p>
                {item.where && (
                  <p className="promo-meta">
                    <MapPin size={14} aria-hidden="true" />
                    {item.where}
                  </p>
                )}
                <p className="promo-copy">{item.copy}</p>
              </div>
            </article>
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
