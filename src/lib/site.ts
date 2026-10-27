// The public address search engines and shared links should use (canonical URLs, sitemap, structured data).
export const SITE_URL = "https://cannaplug012.co.za";

/** <link rel="canonical"> and og:url for a public page. Query strings are dropped except an allowed category. */
export function canonical(path: string): {
  links: { rel: string; href: string }[];
  meta: { property: string; content: string }[];
} {
  const href = `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  return { links: [{ rel: "canonical", href }], meta: [{ property: "og:url", content: href }] };
}

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export type SitemapEntry = { path: string; lastmod?: string | null; priority?: number };

export const STATIC_PAGES: SitemapEntry[] = [
  { path: "/", priority: 1 },
  { path: "/shop", priority: 0.9 },
  { path: "/journal", priority: 0.8 },
  { path: "/about", priority: 0.5 },
  { path: "/calendar", priority: 0.4 },
  { path: "/faq", priority: 0.5 },
  { path: "/delivery-policy", priority: 0.3 },
  { path: "/refund-policy", priority: 0.3 },
  { path: "/privacy-policy", priority: 0.3 },
  { path: "/terms-of-service", priority: 0.3 },
];

export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries.map((e) => {
    const parts = [`<loc>${xmlEscape(SITE_URL + e.path)}</loc>`];
    if (e.lastmod) parts.push(`<lastmod>${e.lastmod.slice(0, 10)}</lastmod>`);
    if (e.priority !== undefined) parts.push(`<priority>${e.priority.toFixed(1)}</priority>`);
    return `  <url>${parts.join("")}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
