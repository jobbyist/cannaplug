import { createFileRoute } from "@tanstack/react-router";

/**
 * /sitemap.xml: public pages, a page per shop category that has products on sale online, and every published
 * Journal article. Reads public columns only. Cached for an hour.
 */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const [{ supabaseAdmin }, { STATIC_PAGES, sitemapXml }] = await Promise.all([
          import("@/integrations/supabase/client.server"),
          import("@/lib/site"),
        ]);
        const entries = [...STATIC_PAGES];
        try {
          const [products, articles] = await Promise.all([
            supabaseAdmin
              .from("products")
              .select("category")
              .eq("is_active", true)
              .eq("sell_online", true),
            supabaseAdmin
              .from("articles")
              .select("slug,published_at")
              .lte("published_at", new Date().toISOString())
              .order("published_at", { ascending: false })
              .limit(1000),
          ]);
          const categories = [...new Set((products.data ?? []).map((p) => p.category))].sort();
          for (const c of categories)
            entries.push({ path: `/shop?category=${encodeURIComponent(c)}`, priority: 0.7 });
          for (const a of articles.data ?? [])
            entries.push({ path: `/journal/${a.slug}`, lastmod: a.published_at, priority: 0.6 });
        } catch (err) {
          // a database outage still serves the static pages
          console.error(
            "sitemap: catalogue unavailable",
            err instanceof Error ? err.message : "error",
          );
        }
        return new Response(sitemapXml(entries), {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
