-- 29 Oct 2026: the Journal's articles are published under the name Michael C.
--   The seven launch and scheduled articles were inserted under "Dithekgo M." by migrations 20261028003000 and
--   20261028007000 (kept as they were, since they are already applied). This renames the author on all of them,
--   the four published on 25 to 28 October and the three scheduled for 8 AM SAST on 29, 30 and 31 October.
--   Only the byline changes: titles, text, dates, comments and likes are untouched.
UPDATE public.articles
   SET author_name = 'Michael C.', updated_at = now()
 WHERE author_name = 'Dithekgo M.';
