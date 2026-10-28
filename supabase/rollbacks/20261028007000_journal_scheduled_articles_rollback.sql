-- Rollback for 20261028007000_journal_scheduled_articles: removes the three scheduled articles (and anything that
-- hung off them). Refused once any of them has been liked or commented on by a real member.
DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.article_likes l JOIN public.articles a ON a.id = l.article_id
       WHERE a.slug IN ('cannabis-etiquette-south-africa-considerate-consumer',
                        'flower-pre-rolls-edibles-product-formats-explained',
                        'what-to-look-for-in-a-trustworthy-cannabis-store'))
     OR EXISTS (
       SELECT 1 FROM public.article_comments c JOIN public.articles a ON a.id = c.article_id
       WHERE NOT c.is_seed AND a.slug IN ('cannabis-etiquette-south-africa-considerate-consumer',
                        'flower-pre-rolls-edibles-product-formats-explained',
                        'what-to-look-for-in-a-trustworthy-cannabis-store')) THEN
    RAISE EXCEPTION 'rollback_blocked: members have liked or commented on these articles';
  END IF;
END $$;

DELETE FROM public.articles WHERE slug IN (
  'cannabis-etiquette-south-africa-considerate-consumer',
  'flower-pre-rolls-edibles-product-formats-explained',
  'what-to-look-for-in-a-trustworthy-cannabis-store');
