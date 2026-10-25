import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE_URL, STATIC_PAGES, canonical, sitemapXml } from "@/lib/site";
import { parseDsn, scrub, sentryEvent } from "@/lib/monitoring";

describe("sitemap and canonical URLs", () => {
  it("builds a valid sitemap with escaped URLs on the production domain", () => {
    const xml = sitemapXml([
      ...STATIC_PAGES,
      { path: "/shop?category=Pre-rolls&x=<y>", priority: 0.7 },
      { path: "/journal/a-story", lastmod: "2026-10-24T05:00:00Z", priority: 0.6 },
    ]);
    expect(xml).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/,
    );
    expect(xml).toContain(`<loc>${SITE_URL}/</loc>`);
    expect(xml).toContain(
      "<loc>https://cannaplug012.co.za/shop?category=Pre-rolls&amp;x=&lt;y&gt;</loc>",
    );
    expect(xml).toContain("<lastmod>2026-10-24</lastmod>");
    expect(xml).not.toMatch(/\/(admin|account|checkout|doctor)/);
  });

  it("canonical links point at cannaplug012.co.za and robots.txt lists the sitemap and hides private areas", () => {
    expect(canonical("/faq")).toEqual({
      links: [{ rel: "canonical", href: "https://cannaplug012.co.za/faq" }],
      meta: [{ property: "og:url", content: "https://cannaplug012.co.za/faq" }],
    });
    const robots = readFileSync("public/robots.txt", "utf8");
    expect(robots).toContain("Sitemap: https://cannaplug012.co.za/sitemap.xml");
    for (const p of ["/admin", "/account", "/checkout", "/doctor", "/api/"])
      expect(robots).toContain(`Disallow: ${p}`);
    for (const f of [
      "index",
      "shop",
      "faq",
      "about",
      "journal.index",
      "journal.$slug",
      "privacy-policy",
    ])
      expect(readFileSync(`src/routes/${f}.tsx`, "utf8"), f).toContain("canonical(");
    expect(readFileSync("src/routes/journal.$slug.tsx", "utf8")).not.toContain("lovable.app");
  });
});

describe("monitoring (Sentry) is optional and scrubbed", () => {
  it("is off without a valid DSN", () => {
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn("not a url")).toBeNull();
    expect(parseDsn("https://o1.ingest.sentry.io/123")).toBeNull(); // no key
    expect(parseDsn("https://abc123@o1.ingest.de.sentry.io/4507")).toEqual({
      publicKey: "abc123",
      host: "o1.ingest.de.sentry.io",
      projectId: "4507",
      protocol: "https:",
    });
  });

  it("removes emails, phone and ID numbers, ids, tokens, keys and query values", () => {
    const raw =
      "failed for thandi@example.co.za +27 68 291 2107 / 0682912107 id 9001015800085 user 3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90 " +
      "token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl key re_abcdefgh1234 at /verify?token=abc&x=1 order 123456789";
    const out = scrub(raw);
    for (const leak of [
      "thandi",
      "291 2107",
      "0682912107",
      "9001015800085",
      "3f2a9c1e",
      "eyJ",
      "re_abcdefgh",
      "token=abc",
      "123456789",
    ])
      expect(out, leak).not.toContain(leak);
  });

  it("an event carries no request data", () => {
    const e = sentryEvent(new Error("boom for a@b.co"), "staff server function", "abc");
    const json = JSON.stringify(e);
    expect(json).not.toMatch(/a@b\.co|request|headers|cookies|user/);
    expect(e.exception.values[0]!.value).toBe("boom for [email]");
  });
});
