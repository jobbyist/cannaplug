import { describe, expect, it } from "vitest";
import type { JournalArticle } from "@/lib/journal";
import { articleHead, articleSchema, breadcrumbSchema } from "@/lib/journal-seo";

const article = (over: Partial<JournalArticle> = {}): JournalArticle => ({
  id: "a1",
  slug: "terpenes-explained",
  title: "Terpenes Explained",
  excerpt: "Why does one strain smell of citrus and another of pine?",
  category: "Culture",
  body_md: "## One\n\nWords here and more words.\n\n## Two\n\nMore.",
  reading_minutes: 4,
  cover_image_url: "https://images.unsplash.com/photo-1?w=1600",
  cover_credit_name: "Jane Doe",
  cover_credit_url: "https://unsplash.com/@jane",
  cover_alt: "Citrus peel",
  sources: [{ title: "Source", url: "https://example.org/s" }],
  published_at: "2026-10-28T04:00:00Z",
  author_name: "Dithekgo M.",
  keywords: ["terpenes", "aroma"],
  featured: true,
  updated_at: "2026-10-28T05:00:00Z",
  inline_images: [
    {
      url: "https://images.unsplash.com/photo-2?w=1200",
      alt: "Pine",
      credit_name: "A",
      credit_url: "u",
      after_section: 1,
    },
  ],
  ...over,
});

describe("article structured data and meta", () => {
  it("describes a schema.org Article by a Person with dates, images, keywords and publisher", () => {
    const s = articleSchema(article());
    expect(s["@type"]).toBe("Article");
    expect(s.author).toMatchObject({ "@type": "Person", name: "Dithekgo M." });
    expect(s.publisher).toMatchObject({ "@type": "Organization", name: "Cannaplug" });
    expect(s.publisher.logo.url).toMatch(/^https:\/\/cannaplug012\.co\.za\//);
    expect(s.datePublished).toBe("2026-10-28T04:00:00Z");
    expect(s.dateModified).toBe("2026-10-28T05:00:00Z");
    expect(s.image).toEqual([
      "https://images.unsplash.com/photo-1?w=1600",
      "https://images.unsplash.com/photo-2?w=1200",
    ]);
    expect(s.keywords).toBe("terpenes, aroma");
    expect(s.inLanguage).toBe("en-ZA");
    expect(s.mainEntityOfPage["@id"]).toBe("https://cannaplug012.co.za/journal/terpenes-explained");
    expect(s.citation).toEqual(["https://example.org/s"]);
  });

  it("older articles without an author stay credited to the Journal, and always have an image", () => {
    const s = articleSchema(
      article({ author_name: null, cover_image_url: null, inline_images: [], updated_at: null }),
    );
    expect(s.author["@type"]).toBe("Organization");
    expect(s.dateModified).toBe(s.datePublished);
    expect(s.image[0]).toMatch(/social-preview/);
  });

  it("has breadcrumbs, a canonical URL, Open Graph and Twitter tags and article tags", () => {
    const a = article();
    expect(breadcrumbSchema(a).itemListElement.map((i) => i.name)).toEqual([
      "Home",
      "Journal",
      "Terpenes Explained",
    ]);
    const h = articleHead(a);
    expect(h.links).toEqual([
      { rel: "canonical", href: "https://cannaplug012.co.za/journal/terpenes-explained" },
    ]);
    const meta = (k: string, v = "name") =>
      h.meta
        .filter((m) => (m as Record<string, string>)[v] === k)
        .map((m) => (m as { content: string }).content);
    expect(meta("og:type", "property")).toEqual(["article"]);
    expect(meta("og:site_name", "property")).toEqual(["Cannaplug"]);
    expect(meta("og:image:alt", "property")).toEqual(["Citrus peel"]);
    expect(meta("article:author", "property")).toEqual(["Dithekgo M."]);
    expect(meta("article:tag", "property")).toEqual(["terpenes", "aroma"]);
    expect(meta("twitter:title")).toEqual(["Terpenes Explained"]);
    expect(meta("author")).toEqual(["Dithekgo M."]);
    expect(h.scripts.map((s) => JSON.parse(s.children)["@type"])).toEqual([
      "Article",
      "BreadcrumbList",
    ]);
  });
});
