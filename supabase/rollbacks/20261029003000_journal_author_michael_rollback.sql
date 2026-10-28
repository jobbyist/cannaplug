-- Rollback for 20261029003000_journal_author_michael: puts the byline "Dithekgo M." back on the seven launch and
-- scheduled articles (found by slug, so an article written later under Michael C. is not touched).
UPDATE public.articles
   SET author_name = 'Dithekgo M.', updated_at = now()
 WHERE author_name = 'Michael C.'
   AND slug IN (
     'south-africa-cannabis-law-private-use-explained',
     'how-to-read-a-cannabis-product-label',
     'storing-cannabis-at-home-freshness-and-safety',
     'terpenes-explained-the-aroma-behind-your-strain',
     'cannabis-etiquette-south-africa-considerate-consumer',
     'flower-pre-rolls-edibles-product-formats-explained',
     'what-to-look-for-in-a-trustworthy-cannabis-store');
