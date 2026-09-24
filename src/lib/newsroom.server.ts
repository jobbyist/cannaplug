// Editorial pipeline: Firecrawl research -> Gemini draft -> Gemini editor review -> Unsplash cover -> publish.
import { EDITORIAL_MODEL, geminiStream, GatewayError } from "./ai-gateway.server";

export const JOURNAL_CATEGORIES = ["Culture", "Industry", "Law & Policy", "Wellness", "Lifestyle"] as const;

const TOPIC_SEEDS = [
  "South African cannabis culture news",
  "Cannabis for Private Purposes Act South Africa update",
  "South African hemp industry farmers",
  "Rastafari cannabis heritage South Africa",
  "Cape Town Johannesburg Pretoria cannabis clubs",
  "dagga history South Africa indigenous",
  "South Africa cannabis tourism",
  "SAHPRA medical cannabis South Africa",
  "Eastern Cape cannabis growers smallholder",
  "African cannabis industry investment 2026",
  "cannabis events festival South Africa",
  "South African cannabis entrepreneurs women",
];

type Source = { url: string; title: string; content: string };
type Draft = {
  title: string;
  excerpt: string;
  category: string;
  keywords: string[];
  unsplash_query: string;
  body_md: string;
};

async function research(query: string): Promise<Source[]> {
  const key = process.env["FIRECRAWL_API_KEY"];
  if (!key) throw new Error("Firecrawl is not connected.");
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      limit: 9,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    }),
  });
  if (!res.ok) throw new Error(`Firecrawl search failed (${res.status})`);
  const json = (await res.json()) as {
    data?: { web?: { url: string; title?: string; description?: string; markdown?: string }[] } | { url: string; title?: string; description?: string; markdown?: string }[];
  };
  const items = Array.isArray(json.data) ? json.data : (json.data?.web ?? []);
  return items
    .filter((i) => i.url)
    .map((i) => ({
      url: i.url,
      title: i.title ?? i.url,
      content: (i.markdown || i.description || "").slice(0, 3000),
    }))
    .filter((s) => s.content.length > 120);
}

function parseJson(text: string): Draft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Model did not return JSON");
  const d = JSON.parse(text.slice(start, end + 1)) as Draft;
  if (!d.title || !d.body_md || d.body_md.length < 3000) throw new Error("Draft too short");
  return d;
}

const STYLE = `You write for The CannaPlug Journal, the editorial arm of CannaPlug, a licensed premium cannabis dispensary in Pretoria, South Africa.
Voice: casual, warm and intelligent, with a proudly African perspective. Accurate, balanced, no hype, no medical or dosing claims, never encourage illegal activity.
Structure rules for body_md (Markdown):
- Do NOT include an H1 (the title is rendered separately).
- 5 to 7 sections, each starting with "## " followed by a strong, short section title.
- Inside sections use "### " subheadings where useful.
- Short readable paragraphs (2 to 4 sentences), occasional bullet lists, one blockquote.
- 1200 to 1600 words total. End with a "## The Takeaway" section.
- Do not include a sources list or links inside the body.
SEO: natural use of keywords, descriptive title under 70 characters, excerpt 140 to 160 characters.`;

const SHAPE = `Respond with json only, exactly this shape:
{"title": string, "excerpt": string, "category": one of ${JOURNAL_CATEGORIES.map((c) => `"${c}"`).join(", ")}, "keywords": string[5], "unsplash_query": short 2-4 word photo search, "body_md": string}`;

async function writeArticle(sources: Source[], recentTitles: string[]): Promise<Draft> {
  const brief = sources
    .map((s, i) => `SOURCE ${i + 1}: ${s.title}\nURL: ${s.url}\n${s.content}`)
    .join("\n\n---\n\n");
  const draftText = await geminiStream(EDITORIAL_MODEL, [
    { role: "system", content: `${STYLE}\n\n${SHAPE}` },
    {
      role: "user",
      content: `Using the research below, write one original, well-structured feature article about South African cannabis culture. Synthesize multiple sources; do not copy sentences.\nAvoid repeating these recent headlines: ${recentTitles.join(" | ") || "none"}.\n\nRESEARCH:\n${brief}`,
    },
  ]);
  const draft = parseJson(draftText);

  // Editorial review pass
  const reviewedText = await geminiStream(EDITORIAL_MODEL, [
    { role: "system", content: `You are the senior editor of The CannaPlug Journal.\n${STYLE}\n\n${SHAPE}` },
    {
      role: "user",
      content: `Review and improve this draft. Fix factual overreach against the research, remove medical claims, tighten prose, strengthen headings and SEO, and keep the required structure and length. Return the final article as json.\n\nDRAFT:\n${JSON.stringify(draft)}\n\nRESEARCH TITLES:\n${sources.map((s) => `${s.title} (${s.url})`).join("\n")}`,
    },
  ]);
  try {
    return parseJson(reviewedText);
  } catch {
    return draft;
  }
}

async function findCover(query: string) {
  const key = process.env["UNSPLASH_ACCESS_KEY"];
  if (!key) return null;
  const res = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=10&content_filter=high`,
    { headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    results?: { urls: { regular: string; raw: string }; user: { name: string; links: { html: string } }; links: { download_location: string } }[];
  };
  const pool = json.results ?? [];
  if (!pool.length) return null;
  const photo = pool[Math.floor(Math.random() * Math.min(pool.length, 6))];
  // Required by Unsplash API guidelines
  fetch(photo.links.download_location, { headers: { Authorization: `Client-ID ${key}` } }).catch(() => {});
  return {
    url: `${photo.urls.raw}&w=1600&q=80&fit=crop&auto=format`,
    name: photo.user.name,
    profile: `${photo.user.links.html}?utm_source=cannaplug&utm_medium=referral`,
  };
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}

export async function generateAndPublishArticle(publishedAt?: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: state } = await supabaseAdmin.from("newsroom_job_state").select("*").eq("id", "default").maybeSingle();
  if (state?.paused_at) throw new Error(`Pipeline paused: ${state.paused_reason ?? "unknown"}`);

  const { data: recent } = await supabaseAdmin
    .from("articles")
    .select("title")
    .order("published_at", { ascending: false })
    .limit(15);
  const recentTitles = (recent ?? []).map((r) => r.title);

  try {
    let sources: Source[] = [];
    const seeds = [...TOPIC_SEEDS].sort(() => Math.random() - 0.5);
    for (const seed of seeds.slice(0, 3)) {
      const found = await research(seed);
      sources = [...sources, ...found.filter((f) => !sources.some((s) => s.url === f.url))];
      if (sources.length >= 8) break;
    }
    sources = sources.slice(0, 10);
    if (sources.length < 4) throw new Error("Not enough research sources found");

    const article = await writeArticle(sources, recentTitles);
    const cover = await findCover(article.unsplash_query || "cannabis South Africa");
    const words = article.body_md.split(/\s+/).length;
    const category = (JOURNAL_CATEGORIES as readonly string[]).includes(article.category) ? article.category : "Culture";
    const slug = `${slugify(article.title)}-${Math.random().toString(36).slice(2, 6)}`;

    const { data: inserted, error } = await supabaseAdmin
      .from("articles")
      .insert({
        slug,
        title: article.title,
        excerpt: article.excerpt,
        category,
        body_md: article.body_md,
        reading_minutes: Math.max(3, Math.round(words / 220)),
        cover_image_url: cover?.url ?? null,
        cover_credit_name: cover?.name ?? null,
        cover_credit_url: cover?.profile ?? null,
        sources: sources.map((s) => ({ url: s.url, title: s.title })),
        ...(publishedAt ? { published_at: publishedAt } : {}),
      })
      .select("slug, title")
      .single();
    if (error) throw error;

    await supabaseAdmin
      .from("newsroom_job_state")
      .upsert({ id: "default", last_run_at: new Date().toISOString(), last_error: null });
    return inserted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pause = error instanceof GatewayError && (error.status === 402 || error.status === 403);
    await supabaseAdmin.from("newsroom_job_state").upsert({
      id: "default",
      last_run_at: new Date().toISOString(),
      last_error: message,
      ...(pause ? { paused_at: new Date().toISOString(), paused_reason: message } : {}),
    });
    throw error;
  }
}
