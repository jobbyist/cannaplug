import { SITE_URL, canonical } from "@/lib/site";
import { DEFAULT_AUTHOR, type JournalArticle } from "@/lib/journal";

/** Structured data and meta tags for an article page. Pure, so it is tested without rendering. */
const SOCIAL_FALLBACK = `${SITE_URL}/social-preview.jpg`;

export const articleImages = (a: JournalArticle): string[] => [
  ...(a.cover_image_url ? [a.cover_image_url] : []),
  ...(a.inline_images ?? []).map((i) => i.url),
];

export const wordCount = (md: string) => md.split(/\s+/).filter(Boolean).length;

export function articleSchema(a: JournalArticle) {
  const author = a.author_name ?? DEFAULT_AUTHOR;
  const images = articleImages(a);
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.title,
    description: a.excerpt,
    image: images.length ? images : [SOCIAL_FALLBACK],
    datePublished: a.published_at,
    dateModified: a.updated_at ?? a.published_at,
    articleSection: a.category,
    keywords: a.keywords?.length ? a.keywords.join(", ") : undefined,
    wordCount: wordCount(a.body_md),
    inLanguage: "en-ZA",
    isAccessibleForFree: true,
    author: a.author_name
      ? {
          "@type": "Person",
          name: author,
          url: `${SITE_URL}/journal`,
          worksFor: { "@type": "Organization", name: "Cannaplug" },
        }
      : { "@type": "Organization", name: author, url: `${SITE_URL}/journal` },
    publisher: {
      "@type": "Organization",
      name: "Cannaplug",
      url: SITE_URL,
      logo: { "@type": "ImageObject", url: `${SITE_URL}/favicon-512.png`, width: 512, height: 512 },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE_URL}/journal/${a.slug}` },
    citation: a.sources?.length ? a.sources.map((s) => s.url) : undefined,
  };
}

export function breadcrumbSchema(a: JournalArticle) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: "Journal", item: `${SITE_URL}/journal` },
      { "@type": "ListItem", position: 3, name: a.title, item: `${SITE_URL}/journal/${a.slug}` },
    ],
  };
}

export function articleHead(a: JournalArticle) {
  const c = canonical(`/journal/${a.slug}`);
  const image = a.cover_image_url ?? SOCIAL_FALLBACK;
  return {
    links: c.links,
    meta: [
      ...c.meta,
      { title: `${a.title} | The CannaPlug Journal` },
      { name: "description", content: a.excerpt },
      ...(a.keywords?.length ? [{ name: "keywords", content: a.keywords.join(", ") }] : []),
      { name: "author", content: a.author_name ?? DEFAULT_AUTHOR },
      { property: "og:site_name", content: "Cannaplug" },
      { property: "og:locale", content: "en_ZA" },
      { property: "og:title", content: a.title },
      { property: "og:description", content: a.excerpt },
      { property: "og:type", content: "article" },
      { property: "og:image", content: image },
      { property: "og:image:alt", content: a.cover_alt ?? a.title },
      { property: "article:published_time", content: a.published_at },
      { property: "article:modified_time", content: a.updated_at ?? a.published_at },
      { property: "article:section", content: a.category },
      { property: "article:author", content: a.author_name ?? DEFAULT_AUTHOR },
      ...(a.keywords ?? []).map((k) => ({ property: "article:tag", content: k })),
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: a.title },
      { name: "twitter:description", content: a.excerpt },
      { name: "twitter:image", content: image },
    ],
    scripts: [
      { type: "application/ld+json", children: JSON.stringify(articleSchema(a)) },
      { type: "application/ld+json", children: JSON.stringify(breadcrumbSchema(a)) },
    ],
  };
}
