import { canonical } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ArrowRight, Clock3 } from "lucide-react";
import { z } from "zod";
import { Header, Footer } from "@/components/CannaPlugHome";
import {
  JOURNAL_CATEGORIES,
  journalListQuery,
  formatJournalDate,
  UNSPLASH_REF,
  type JournalListItem,
} from "@/lib/journal";

export const Route = createFileRoute("/journal/")({
  validateSearch: z.object({ category: z.string().optional() }),
  loader: ({ context }) => context.queryClient.ensureQueryData(journalListQuery()),
  head: () => ({
    links: canonical("/journal").links,
    meta: [
      ...canonical("/journal").meta,
      { title: "The CannaPlug Journal | South African Cannabis Culture" },
      {
        name: "description",
        content:
          "Stories, news and culture from South Africa's cannabis scene, written by The CannaPlug Journal in Pretoria.",
      },
      { property: "og:title", content: "The CannaPlug Journal" },
      {
        property: "og:description",
        content: "South African cannabis culture, industry and lifestyle stories.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: JournalIndex,
});

function Cover({ a, className }: { a: JournalListItem; className?: string }) {
  return a.cover_image_url ? (
    <img
      src={a.cover_image_url}
      alt={a.cover_alt ?? a.title}
      loading="lazy"
      decoding="async"
      className={className}
    />
  ) : (
    <div className={`journal-cover-fallback ${className ?? ""}`} />
  );
}

function JournalIndex() {
  const { data } = useSuspenseQuery(journalListQuery());
  const { category } = Route.useSearch();
  const filtered = category ? data.filter((a) => a.category === category) : data;
  const [lead, ...rest] = filtered;

  return (
    <div className="site">
      <Header />
      <main className="journal">
        <header className="journal-masthead">
          <p className="eyebrow">Good plants. Great stories.</p>
          <h1>THE CANNAPLUG JOURNAL</h1>
          <p>Culture, industry and lifestyle from South Africa's cannabis community.</p>
        </header>

        <nav className="journal-filters" aria-label="Filter by category">
          <Link to="/journal" search={{}} className={!category ? "active" : ""}>
            All
          </Link>
          {JOURNAL_CATEGORIES.map((c) => (
            <Link
              key={c}
              to="/journal"
              search={{ category: c }}
              className={category === c ? "active" : ""}
            >
              {c}
            </Link>
          ))}
        </nav>

        {!lead ? (
          <p className="journal-empty">No stories in this category yet. Check back soon.</p>
        ) : (
          <>
            <Link to="/journal/$slug" params={{ slug: lead.slug }} className="journal-lead">
              <Cover a={lead} />
              <div>
                <p className="eyebrow">
                  {lead.featured && <span className="journal-featured-tag">Featured</span>}
                  {lead.category} · {formatJournalDate(lead.published_at)}
                </p>
                <h2>{lead.title}</h2>
                <p>{lead.excerpt}</p>
                {lead.author_name && <p className="journal-byline">By {lead.author_name}</p>}
                <span className="journal-more">
                  Read story <ArrowRight size={15} />
                </span>
              </div>
            </Link>
            <div className="journal-grid">
              {rest.map((a) => (
                <Link
                  key={a.id}
                  to="/journal/$slug"
                  params={{ slug: a.slug }}
                  className="journal-card"
                >
                  <div className="journal-card-img">
                    <Cover a={a} />
                  </div>
                  <p className="eyebrow">
                    {a.featured && <span className="journal-featured-tag">Featured</span>}
                    {a.category} · {formatJournalDate(a.published_at)}
                  </p>
                  <h3>{a.title}</h3>
                  <p>{a.excerpt}</p>
                  {a.author_name && <p className="journal-byline">By {a.author_name}</p>}
                  <small>
                    <Clock3 size={13} /> {a.reading_minutes} min read
                  </small>
                </Link>
              ))}
            </div>
            <p className="journal-credit-note">
              Cover photography via{" "}
              <a href={UNSPLASH_REF} target="_blank" rel="noreferrer">
                Unsplash
              </a>
              , credited on each story.
            </p>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
