import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { assertRole } from "@/lib/admin-data.server";
import {
  pickArticleImages,
  type FetchLike,
  type ImageQuery,
  type InlineImage,
} from "@/lib/journal-images";

/** Turns a database exception into a short, safe message for the browser. */
const MESSAGES: Record<string, string> = {
  forbidden: "Please sign in to do that.",
  rate_limited: "You are commenting very quickly. Please wait a few minutes.",
  duplicate_comment: "You already posted that comment.",
  invalid_input: "Please check your comment and try again.",
  article_not_found: "That article could not be found.",
  comment_not_found: "That comment could not be found.",
  reason_required: "A reason is required.",
};
export function friendlyJournalError(err: unknown): Error {
  const raw =
    err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
  const code = /^([a-z_]+)(?::|$)/.exec(raw)?.[1];
  const detail = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1).trim() : "";
  if (code === "rate_limited" || code === "invalid_input" || code === "duplicate_comment")
    return new Error(
      detail ? detail.charAt(0).toUpperCase() + detail.slice(1) + "." : MESSAGES[code]!,
    );
  if (code && MESSAGES[code]) return new Error(MESSAGES[code]!);
  return new Error("Something went wrong. Please try again.");
}

async function articleIdForSlug(slug: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("articles")
    .select("id")
    .eq("slug", slug)
    .lte("published_at", new Date().toISOString())
    .maybeSingle();
  return data?.id ?? null;
}

export type JournalEngagement = {
  articleId: string;
  likeCount: number;
  comments: { id: string; name: string; body: string; at: string }[];
};

/** Public: like count and the visible comments. No user ids or emails are returned. */
export async function getEngagement(slug: string): Promise<JournalEngagement | null> {
  const articleId = await articleIdForSlug(slug);
  if (!articleId) return null;
  const [likes, comments] = await Promise.all([
    supabaseAdmin
      .from("article_likes")
      .select("user_id", { count: "exact", head: true })
      .eq("article_id", articleId)
      .eq("liked", true),
    supabaseAdmin
      .from("article_comments")
      .select("id,display_name,body,created_at")
      .eq("article_id", articleId)
      .is("hidden_at", null)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);
  if (likes.error) throw likes.error;
  if (comments.error) throw comments.error;
  return {
    articleId,
    likeCount: likes.count ?? 0,
    comments: (comments.data ?? []).map((c) => ({
      id: c.id,
      name: c.display_name,
      body: c.body,
      at: c.created_at,
    })),
  };
}

export async function getMyLike(userId: string, articleId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("article_likes")
    .select("liked")
    .eq("article_id", articleId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw friendlyJournalError(error);
  return data?.liked === true;
}

export async function setLike(userId: string, articleId: string, liked: boolean) {
  const { data, error } = await supabaseAdmin.rpc("article_set_like", {
    p_actor: userId,
    p_article_id: articleId,
    p_liked: liked,
  });
  if (error) throw friendlyJournalError(error);
  return data as { liked: boolean; like_count: number };
}

export async function addComment(userId: string, articleId: string, body: string, key: string) {
  const { data, error } = await supabaseAdmin.rpc("article_add_comment", {
    p_actor: userId,
    p_article_id: articleId,
    p_body: body,
    p_idempotency_key: key,
  });
  if (error) throw friendlyJournalError(error);
  return data as { comment_id: string; display_name: string };
}

export async function hideComment(userId: string, commentId: string, reason: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin.rpc("article_hide_comment", {
    p_actor: userId,
    p_comment_id: commentId,
    p_reason: reason,
  });
  if (error) throw friendlyJournalError(error);
  return data;
}

/** Manager+: recent comments (including seeded ones) with their article, for moderation. */
export async function listRecentComments(userId: string) {
  await assertRole(userId, "manager");
  const { data, error } = await supabaseAdmin
    .from("article_comments")
    .select("id,display_name,body,is_seed,created_at,hidden_at,article_id,articles(title,slug)")
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) throw friendlyJournalError(error);
  return (data ?? []).map((c) => ({
    id: c.id,
    name: c.display_name,
    body: c.body,
    isSeed: c.is_seed,
    at: c.created_at,
    hidden: c.hidden_at !== null,
    article: (c.articles as unknown as { title: string; slug: string } | null) ?? null,
  }));
}

const nodeFetch: FetchLike = async (u, i) => {
  const r = await fetch(u, i as RequestInit);
  return { ok: r.ok, status: r.status, json: () => r.json() };
};

export type ImageFetchReport = {
  articles: { slug: string; cover: boolean; inline: number; missing: string[] }[];
};

/**
 * Manager+: gives every article that asked for photos (image_queries) a cover and inline photos from Unsplash.
 * Photos already set are kept, so it is safe to run again; it fills only what is missing.
 */
export async function fetchArticleImages(
  userId: string,
  env: Record<string, string | undefined> = process.env,
  fetchFn: FetchLike = nodeFetch,
): Promise<ImageFetchReport> {
  await assertRole(userId, "manager");
  const key = env["UNSPLASH_ACCESS_KEY"];
  if (!key)
    throw new Error("UNSPLASH_ACCESS_KEY is not set in Vercel, so photos cannot be fetched.");
  const { data, error } = await supabaseAdmin
    .from("articles")
    .select("id,slug,cover_image_url,inline_images,image_queries")
    .lte("published_at", new Date().toISOString());
  if (error) throw error;
  const used = new Set<string>();
  const report: ImageFetchReport = { articles: [] };
  for (const a of data ?? []) {
    const queries = (a.image_queries ?? []) as unknown as ImageQuery[];
    if (!Array.isArray(queries) || queries.length === 0) continue;
    const inlineNow = (a.inline_images ?? []) as unknown as InlineImage[];
    const picked = await pickArticleImages(
      fetchFn,
      key,
      queries,
      { hasCover: !!a.cover_image_url, inlineAfter: inlineNow.map((i) => i.after_section) },
      used,
    );
    const patch: Database["public"]["Tables"]["articles"]["Update"] = {};
    if (picked.cover) {
      patch.cover_image_url = picked.cover.url;
      patch.cover_alt = picked.cover.alt;
      patch.cover_credit_name = picked.cover.credit_name;
      patch.cover_credit_url = picked.cover.credit_url;
    }
    if (picked.inline.length)
      patch.inline_images = [...inlineNow, ...picked.inline].sort(
        (x, y) => x.after_section - y.after_section,
      ) as unknown as Json;
    if (Object.keys(patch).length) {
      patch.updated_at = new Date().toISOString();
      const { error: upErr } = await supabaseAdmin.from("articles").update(patch).eq("id", a.id);
      if (upErr) throw upErr;
    }
    report.articles.push({
      slug: a.slug,
      cover: !!picked.cover || !!a.cover_image_url,
      inline: inlineNow.length + picked.inline.length,
      missing: picked.missing,
    });
  }
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "journal_images_fetched",
    entity_type: "articles",
    entity_id: null,
    metadata: { articles: report.articles.length },
  });
  return report;
}
