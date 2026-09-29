-- Repair schema drift on public.articles.
--
-- The live project still had the legacy admin-CMS articles table (content,
-- author_id, status, tags, ...) while the newsroom/journal code and the
-- 20260912145552 migration expect (body_md, category, reading_minutes,
-- cover_*, sources).
--
-- Non-destructive: a legacy-shaped table is renamed to articles_legacy_cms
-- (not dropped) and locked away from anon/authenticated. On databases that
-- already have the newsroom shape this is a no-op.
DO $$
BEGIN
  IF to_regclass('public.articles') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'articles' AND column_name = 'body_md'
  ) THEN
    ALTER TABLE public.articles RENAME TO articles_legacy_cms;
    REVOKE ALL ON public.articles_legacy_cms FROM anon, authenticated;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  body_md text NOT NULL,
  category text NOT NULL DEFAULT 'Cannabis culture',
  reading_minutes int NOT NULL DEFAULT 7,
  cover_image_url text,
  cover_credit_name text,
  cover_credit_url text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Least privilege: public read only; writes go through service_role.
REVOKE ALL ON public.articles FROM anon, authenticated;
GRANT SELECT ON public.articles TO anon, authenticated;
GRANT ALL ON public.articles TO service_role;

ALTER TABLE public.articles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "articles public read" ON public.articles;
CREATE POLICY "articles public read" ON public.articles FOR SELECT TO anon, authenticated USING (true);
