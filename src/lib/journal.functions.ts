import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { friendlyStaffErrors } from "@/lib/staff-errors.middleware";

/**
 * Server-function boundary for Journal likes and comments. Reading is public; liking, commenting and moderating
 * need a signed-in member (the user always comes from the verified session, never from the browser).
 */
const uuid = z.string().uuid();
const lib = () => import("@/lib/journal-engagement.server");

export const getJournalEngagementFn = createServerFn({ method: "GET" })
  .validator((d) => z.object({ slug: z.string().regex(/^[a-z0-9-]{1,120}$/) }).parse(d))
  .handler(async ({ data }) => (await lib()).getEngagement(data.slug));

export const getMyArticleLikeFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ articleId: uuid }).parse(d))
  .handler(async ({ context, data }) => (await lib()).getMyLike(context.userId, data.articleId));

export const setArticleLikeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ articleId: uuid, liked: z.boolean() }).parse(d))
  .handler(async ({ context, data }) =>
    (await lib()).setLike(context.userId, data.articleId, data.liked),
  );

export const addArticleCommentFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) =>
    z
      .object({
        articleId: uuid,
        body: z.string().trim().min(2).max(1000),
        key: z.string().min(8).max(128),
      })
      .parse(d),
  )
  .handler(async ({ context, data }) =>
    (await lib()).addComment(context.userId, data.articleId, data.body, data.key),
  );

// ---- staff (manager+; enforced again in the data layer and by the database) ----

export const hideArticleCommentFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z.object({ commentId: uuid, reason: z.string().trim().min(3).max(200) }).parse(d),
  )
  .handler(async ({ context, data }) =>
    (await lib()).hideComment(context.userId, data.commentId, data.reason),
  );

export const listRecentCommentsFn = createServerFn({ method: "GET" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .handler(async ({ context }) => (await lib()).listRecentComments(context.userId));

export const fetchArticleImagesFn = createServerFn({ method: "POST" })
  .middleware([friendlyStaffErrors, requireSupabaseAuth])
  .validator((d) =>
    z
      .object({})
      .strict()
      .parse(d ?? {}),
  )
  .handler(async ({ context }) => (await lib()).fetchArticleImages(context.userId));
