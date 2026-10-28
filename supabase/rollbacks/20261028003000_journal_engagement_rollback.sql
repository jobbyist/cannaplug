-- Rollback for 20261028003000_journal_engagement: removes likes, comments, the new article columns and the four
-- launch articles. Refused while any real member like or comment exists (seed comments do not count).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.article_likes)
     OR EXISTS (SELECT 1 FROM public.article_comments WHERE NOT is_seed) THEN
    RAISE EXCEPTION 'rollback_blocked: members have liked or commented; keep this migration or export them first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.article_set_like(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.article_add_comment(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.article_hide_comment(uuid, uuid, text);
DROP TABLE IF EXISTS public.article_comments;
DROP TABLE IF EXISTS public.article_likes;
DELETE FROM public.articles WHERE slug IN (
  'south-africa-cannabis-law-private-use-explained',
  'how-to-read-a-cannabis-product-label',
  'storing-cannabis-at-home-freshness-and-safety',
  'terpenes-explained-the-aroma-behind-your-strain');
DROP INDEX IF EXISTS public.articles_featured_idx;
ALTER TABLE public.articles
  DROP COLUMN IF EXISTS author_name,
  DROP COLUMN IF EXISTS keywords,
  DROP COLUMN IF EXISTS featured,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS cover_alt,
  DROP COLUMN IF EXISTS inline_images,
  DROP COLUMN IF EXISTS image_queries;
