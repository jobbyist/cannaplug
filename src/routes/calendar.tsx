import { canonical } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";

export const Route = createFileRoute("/calendar")({
  head: () => ({
    links: canonical("/calendar").links,
    meta: [
      ...canonical("/calendar").meta,
      { title: "Events Calendar | CannaPlug" },
      {
        name: "description",
        content: "The CannaPlug events calendar is coming soon. Follow us for the latest events.",
      },
    ],
  }),
  component: CalendarPage,
});

function CalendarPage() {
  return (
    <div className="site">
      <Header />
      <main className="mx-auto grid w-full max-w-[880px] place-items-center px-4 py-24 text-center sm:px-6 lg:px-8">
        <div className="grid max-w-md justify-items-center gap-4">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-secondary text-primary">
            <CalendarDays size={30} aria-hidden="true" />
          </span>
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
            Coming soon
          </p>
          <h1 className="font-display text-3xl font-extrabold uppercase sm:text-4xl">
            Events calendar
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            We are putting the full CannaPlug events calendar together. Until then, the next events
            are on the home page, and we share news on Instagram and our WhatsApp Channel.
          </p>
          <Link
            to="/"
            hash="events"
            className="mt-2 inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground"
          >
            See upcoming events
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
