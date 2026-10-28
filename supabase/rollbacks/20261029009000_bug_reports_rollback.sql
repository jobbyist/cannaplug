-- Rollback for 20261029009000_bug_reports: removes the form's function and table. Refused while any report is stored
-- (they are feedback from real visitors); export them first and clear the table to roll back. Emails already queued
-- are not touched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bug_reports) THEN
    RAISE EXCEPTION 'bug reports exist: export them and clear public.bug_reports before rolling back';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.bug_report_submit(text, text, text, text, text, text, text, text[], text);
DROP TABLE IF EXISTS public.bug_reports;
