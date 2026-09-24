import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Clock3, Plus } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { supabase } from "@/integrations/supabase/client";
import { useCart, rand } from "@/lib/cart";
import { journalArticleQuery, journalListQuery, formatJournalDate, UNSPLASH_REF } from "@/lib/journal";

export const Route = createFileRoute("/journal/$slug")({
  loader: async ({ context, params }) => {
    const article = await context.queryClient.ensureQueryData(journalArticleQuery(params.slug));
    if (!article) throw notFound();
    await context.queryClient.ensureQueryData(journalListQuery());
    return { article };
  },
  head: ({ loaderData }) => {
    const a = loaderData?.article;
    if (!a) return { meta: [{ title: "Story not found | The CannaPlug Journal" }] };
    const schema = {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: a.title,
      description: a.excerpt,
      image: a.cover_image_url ? [a.cover_image_url] : undefined,
      datePublished: a.published_at,
      dateModified: a.published_at,
      articleSection: a.category,
      wordCount: a.body_md.split(/\s+/).length,
      author: { "@type": "Organization", name: "The CannaPlug Journal", url: "https://cannaplug.lovable.app/journal" },
      publisher: { "@type": "Organization", name: "CannaPlug", url: "https://cannaplug.lovable.app" },
      mainEntityOfPage: { "@type": "WebPage", "@id": `https://cannaplug.lovable.app/journal/${a.slug}` },
      citation: a.sources?.map((s) => s.url),
    };
    const breadcrumbs = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: "https://cannaplug.lovable.app/" },
        { "@type": "ListItem", position: 2, name: "Journal", item: "https://cannaplug.lovable.app/journal" },
        { "@type": "ListItem", position: 3, name: a.title },
      ],
    };
    return {
      meta: [
        { title: `${a.title} | The CannaPlug Journal` },
        { name: "description", content: a.excerpt },
        { property: "og:title", content: a.title },
        { property: "og:description", content: a.excerpt },
        { property: "og:type", content: "article" },
        { property: "article:published_time", content: a.published_at },
        { property: "article:section", content: a.category },
        { name: "twitter:card", content: "summary_large_image" },
        ...(a.cover_image_url
          ? [
              { property: "og:image", content: a.cover_image_url },
              { name: "twitter:image", content: a.cover_image_url },
            ]
          : []),
      ],
      scripts: [
        { type: "application/ld+json", children: JSON.stringify(schema) },
        { type: "application/ld+json", children: JSON.stringify(breadcrumbs) },
      ],
    };
  },
  notFoundComponent: () => (
    <div className="site"><Header /><main className="journal"><p className="journal-empty">That story could not be found. <Link to="/journal">Back to the Journal</Link></p></main><Footer /></div>
  ),
  component: ArticlePage,
});

type ShopProduct = { id: string; name: string; category: string; price_rand: number; unit: string | null; description: string | null };

function ProductCallout({ product }: { product: ShopProduct }) {
  const { add } = useCart();
  return (
    <aside className="journal-product">
      <div>
        <p className="eyebrow">From the CannaPlug menu · {product.category}</p>
        <strong>{product.name}</strong>
        {product.description && <span>{product.description}</span>}
      </div>
      <div className="journal-product-buy">
        <b>{rand(product.price_rand)}{product.unit ? ` / ${product.unit}` : ""}</b>
        <button type="button" onClick={() => add({ productId: product.id, name: product.name, price: product.price_rand, unit: product.unit })}>
          <Plus size={14} /> Add to cart
        </button>
      </div>
    </aside>
  );
}

function ArticlePage() {
  const { slug } = Route.useParams();
  const { data: article } = useSuspenseQuery(journalArticleQuery(slug));
  const { data: all } = useSuspenseQuery(journalListQuery());
  const { data: products } = useQuery({
    queryKey: ["journal-products"],
    queryFn: async () => {
      const { data } = await supabase
        .from("products")
        .select("id, name, category, price_rand, unit, description")
        .eq("is_active", true)
        .limit(60);
      return (data ?? []) as ShopProduct[];
    },
  });
  if (!article) return null;

  const sections = article.body_md.split(/\n(?=## )/);
  const seed = [...article.slug].reduce((n, c) => n + c.charCodeAt(0), 0);
  const picks = products?.length ? [products[seed % products.length], products[(seed * 7 + 3) % products.length]] : [];
  const related = all.filter((a) => a.slug !== article.slug).sort((a, b) => Number(b.category === article.category) - Number(a.category === article.category)).slice(0, 3);

  const blocks: ReactNode[] = sections.map((section, i) => (
    <Fragment key={i}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ h1: "h2" }}>{section}</ReactMarkdown>
      {i === 1 && picks[0] && <ProductCallout product={picks[0]} />}
      {i === 3 && picks[1] && <ProductCallout product={picks[1]} />}
    </Fragment>
  ));

  return (
    <div className="site">
      <Header />
      <main className="journal">
        <article className="journal-article">
          <Link to="/journal" className="journal-back"><ArrowLeft size={15} /> The CannaPlug Journal</Link>
          <p className="eyebrow">{article.category} · {formatJournalDate(article.published_at)} · <Clock3 size={12} /> {article.reading_minutes} min read</p>
          <h1>{article.title}</h1>
          <p className="journal-standfirst">{article.excerpt}</p>
          {article.cover_image_url && (
            <figure className="journal-hero">
              <img src={article.cover_image_url} alt={article.title} />
              {article.cover_credit_name && (
                <figcaption>
                  Photo by <a href={article.cover_credit_url ?? UNSPLASH_REF} target="_blank" rel="noreferrer">{article.cover_credit_name}</a> on{" "}
                  <a href={UNSPLASH_REF} target="_blank" rel="noreferrer">Unsplash</a>
                </figcaption>
              )}
            </figure>
          )}
          <div className="journal-body">{blocks}</div>
          {article.sources?.length > 0 && (
            <section className="journal-sources">
              <h2>Sources &amp; Further Reading</h2>
              <ol>
                {article.sources.map((s) => (
                  <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer nofollow">{s.title}</a></li>
                ))}
              </ol>
            </section>
          )}
        </article>
        {related.length > 0 && (
          <section className="journal-related">
            <h2>RELATED STORIES</h2>
            <div className="journal-grid">
              {related.map((a) => (
                <Link key={a.id} to="/journal/$slug" params={{ slug: a.slug }} className="journal-card">
                  <div className="journal-card-img">{a.cover_image_url ? <img src={a.cover_image_url} alt={a.title} loading="lazy" /> : <div className="journal-cover-fallback" />}</div>
                  <p className="eyebrow">{a.category} · {formatJournalDate(a.published_at)}</p>
                  <h3>{a.title}</h3>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
