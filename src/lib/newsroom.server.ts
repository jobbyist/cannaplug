// Journal pipeline wiring: lease + circuit breaker + Gemini quota + Firecrawl research + Unsplash cover + publish.
import { quotaConfig, takeJobQuota } from "@/lib/ai/quota";
import { GeminiError } from "@/lib/ai/gemini";
import {
  JOURNAL_CATEGORIES,
  TOPIC_SEEDS,
  batchTimestamps,
  dailyRunAllowed,
  research,
  slugify,
  writeArticle,
  type Source,
} from "@/lib/newsroom/pipeline";

export { JOURNAL_CATEGORIES };

const JOB = "daily-article";
const LEASE_MINUTES = 12;

async function findCover(query: string) {
  const key = process.env["UNSPLASH_ACCESS_KEY"];
  if (!key) return null;
  const res = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=10&content_filter=high`,
    { headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    results?: {
      urls: { regular: string; raw: string };
      user: { name: string; links: { html: string } };
      links: { download_location: string };
    }[];
  };
  const pool = json.results ?? [];
  const photo = pool[Math.floor(Math.random() * Math.min(pool.length, 6))];
  if (!photo) return null;
  // Required by Unsplash API guidelines
  fetch(photo.links.download_location, { headers: { Authorization: `Client-ID ${key}` } }).catch(
    () => {},
  );
  return {
    url: `${photo.urls.raw}&w=1600&q=80&fit=crop&auto=format`,
    name: photo.user.name,
    profile: `${photo.user.links.html}?utm_source=cannaplug&utm_medium=referral`,
  };
}

const httpFetch = async (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => {
  const r = await fetch(url, init);
  return {
    ok: r.ok,
    status: r.status,
    text: () => r.text(),
    json: () => r.json() as Promise<unknown>,
  };
};

export type RunMode =
  { kind: "daily" } | { kind: "batch"; count: number } | { kind: "single"; publishedAt?: string };

export interface RunResult {
  published: { slug: string; title: string }[];
  skipped?: "not_due" | "paused" | "busy" | "quota";
  errors: string[];
}

/** Takes the single-flight lease; false when another run holds it. */
async function acquireLease(
  supabaseAdmin: typeof import("@/integrations/supabase/client.server").supabaseAdmin,
): Promise<boolean> {
  const now = new Date();
  await supabaseAdmin
    .from("newsroom_job_state")
    .upsert({ id: JOB }, { onConflict: "id", ignoreDuplicates: true });
  const { data } = await supabaseAdmin
    .from("newsroom_job_state")
    .update({ lease_until: new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString() })
    .eq("id", JOB)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  return (data ?? []).length === 1;
}

export async function runNewsroom(mode: RunMode): Promise<RunResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const geminiKey = process.env["GEMINI_API_KEY"]?.trim();
  const firecrawlKey = process.env["FIRECRAWL_API_KEY"]?.trim();
  if (!geminiKey) throw new Error("GEMINI_API_KEY is not configured.");
  if (!firecrawlKey) throw new Error("FIRECRAWL_API_KEY is not configured.");

  const { data: state } = await supabaseAdmin
    .from("newsroom_job_state")
    .select("*")
    .eq("id", JOB)
    .maybeSingle();
  if (state?.paused_at)
    return { published: [], skipped: "paused", errors: [state.paused_reason ?? "paused"] };

  const { data: recent } = await supabaseAdmin
    .from("articles")
    .select("title, published_at")
    .order("published_at", { ascending: false })
    .limit(15);
  const recentTitles = (recent ?? []).map((r) => r.title);
  const last = recent?.[0]?.published_at ? Date.parse(recent[0].published_at) : null;
  const now = Date.now();
  if (mode.kind === "daily" && !dailyRunAllowed(last, now))
    return { published: [], skipped: "not_due", errors: [] };

  if (!(await acquireLease(supabaseAdmin))) return { published: [], skipped: "busy", errors: [] };

  const count = mode.kind === "batch" ? Math.min(Math.max(mode.count, 1), 3) : 1;
  const stamps =
    mode.kind === "batch"
      ? batchTimestamps(count, now)
      : [
          mode.kind === "single" && mode.publishedAt
            ? mode.publishedAt
            : new Date(now).toISOString(),
        ];
  const cfg = quotaConfig(process.env);
  const quotaDb = {
    async take(bucket: string, limit: number, ttl: number) {
      const { data, error } = await supabaseAdmin.rpc("ai_quota_take", {
        p_bucket: bucket,
        p_limit: limit,
        p_ttl_seconds: ttl,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
  };

  const result: RunResult = { published: [], errors: [] };
  try {
    for (let i = 0; i < count; i++) {
      // an article is two Gemini requests (draft + edit): reserve both before starting
      if (!(await takeJobQuota(quotaDb, cfg)) || !(await takeJobQuota(quotaDb, cfg))) {
        result.skipped = "quota";
        break;
      }
      try {
        let sources: Source[] = [];
        const seeds = [...TOPIC_SEEDS].sort(() => Math.random() - 0.5);
        for (const seed of seeds.slice(0, 3)) {
          const found = await research(httpFetch, firecrawlKey, seed);
          sources = [...sources, ...found.filter((f) => !sources.some((s) => s.url === f.url))];
          if (sources.length >= 8) break;
        }
        sources = sources.slice(0, 10);
        if (sources.length < 4) throw new Error("Not enough research sources found");

        const article = await writeArticle(httpFetch, geminiKey, sources, [
          ...recentTitles,
          ...result.published.map((p) => p.title),
        ]);
        const cover = await findCover(article.unsplash_query);
        const words = article.body_md.split(/\s+/).length;
        const { data: inserted, error } = await supabaseAdmin
          .from("articles")
          .insert({
            slug: `${slugify(article.title)}-${Math.random().toString(36).slice(2, 6)}`,
            title: article.title,
            excerpt: article.excerpt,
            category: article.category,
            body_md: article.body_md,
            reading_minutes: Math.max(3, Math.round(words / 220)),
            cover_image_url: cover?.url ?? null,
            cover_credit_name: cover?.name ?? null,
            cover_credit_url: cover?.profile ?? null,
            sources: sources.map((s) => ({ url: s.url, title: s.title })),
            published_at: stamps[i] ?? new Date().toISOString(),
          })
          .select("slug, title")
          .single();
        if (error) throw error;
        result.published.push(inserted);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(message);
        // a rejected key / exhausted billing is not worth retrying on the next tick: trip the breaker
        if (err instanceof GeminiError && (err.status === 401 || err.status === 403)) {
          await supabaseAdmin.from("newsroom_job_state").upsert({
            id: JOB,
            paused_at: new Date().toISOString(),
            paused_reason: `Gemini rejected the key (${err.status})`,
          });
          break;
        }
      }
    }
  } finally {
    await supabaseAdmin.from("newsroom_job_state").upsert({
      id: JOB,
      lease_until: null,
      last_run_at: new Date().toISOString(),
      last_error: result.errors[0] ?? null,
    });
  }
  return result;
}

/** Back-compat for the admin "run now" button. */
export async function generateAndPublishArticle(publishedAt?: string) {
  const r = await runNewsroom({ kind: "single", ...(publishedAt ? { publishedAt } : {}) });
  if (!r.published[0])
    throw new Error(r.errors[0] ?? `No article published (${r.skipped ?? "unknown"})`);
  return r.published[0];
}
