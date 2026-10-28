/**
 * Unsplash photo picking for the Journal (server-side only; the access key never reaches the browser).
 * Pure and injectable so it can be tested without the network. Follows Unsplash's API guidelines: hot-linked
 * `urls.raw` with sizing parameters, the photographer credited with a UTM-tagged profile link, and the
 * `download_location` ping fired when a photo is chosen.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type PickedPhoto = {
  id: string;
  url: string;
  credit_name: string;
  credit_url: string;
  description: string | null;
};

type UnsplashResult = {
  id: string;
  alt_description?: string | null;
  urls: { raw: string };
  user: { name: string; links: { html: string } };
  links: { download_location: string };
};

const UTM = "utm_source=cannaplug&utm_medium=referral";
const ONLY_UNSPLASH = /^https:\/\/(images\.unsplash\.com|api\.unsplash\.com)\//;

export const photoUrl = (raw: string, width: number) =>
  `${raw}${raw.includes("?") ? "&" : "?"}w=${width}&q=80&fit=crop&auto=format`;

/** First landscape result that has not been used yet, or null. Never throws for an empty or failed search. */
export async function pickUnsplashPhoto(
  fetchFn: FetchLike,
  accessKey: string,
  query: string,
  width: number,
  used: Set<string>,
): Promise<PickedPhoto | null> {
  const headers = { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" };
  const res = await fetchFn(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=10&content_filter=high`,
    { headers },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as { results?: UnsplashResult[] };
  const photo = (json.results ?? []).find(
    (p) => !used.has(p.id) && ONLY_UNSPLASH.test(p.urls?.raw ?? "") && p.user?.name,
  );
  if (!photo) return null;
  used.add(photo.id);
  if (ONLY_UNSPLASH.test(photo.links?.download_location ?? ""))
    void fetchFn(photo.links.download_location, { headers }).catch(() => undefined);
  return {
    id: photo.id,
    url: photoUrl(photo.urls.raw, width),
    credit_name: photo.user.name,
    credit_url: `${photo.user.links.html}${photo.user.links.html.includes("?") ? "&" : "?"}${UTM}`,
    description: photo.alt_description ?? null,
  };
}

export type ImageQuery = {
  role: "cover" | "inline";
  query: string;
  alt: string;
  after_section?: number;
};
export type InlineImage = {
  url: string;
  alt: string;
  credit_name: string;
  credit_url: string;
  after_section: number;
};
export type ArticleImages = {
  cover: { url: string; alt: string; credit_name: string; credit_url: string } | null;
  inline: InlineImage[];
  missing: string[];
};

/** Picks a cover and the inline photos an article asked for. Photos already on the article are kept. */
export async function pickArticleImages(
  fetchFn: FetchLike,
  accessKey: string,
  queries: ImageQuery[],
  existing: { hasCover: boolean; inlineAfter: number[] },
  used: Set<string>,
): Promise<ArticleImages> {
  const out: ArticleImages = { cover: null, inline: [], missing: [] };
  for (const q of queries) {
    if (q.role === "cover") {
      if (existing.hasCover) continue;
      const p = await pickUnsplashPhoto(fetchFn, accessKey, q.query, 1600, used);
      if (p)
        out.cover = {
          url: p.url,
          alt: q.alt,
          credit_name: p.credit_name,
          credit_url: p.credit_url,
        };
      else out.missing.push(q.query);
    } else {
      const after = q.after_section ?? 1;
      if (existing.inlineAfter.includes(after)) continue;
      const p = await pickUnsplashPhoto(fetchFn, accessKey, q.query, 1200, used);
      if (p)
        out.inline.push({
          url: p.url,
          alt: q.alt,
          credit_name: p.credit_name,
          credit_url: p.credit_url,
          after_section: after,
        });
      else out.missing.push(q.query);
    }
  }
  return out;
}
