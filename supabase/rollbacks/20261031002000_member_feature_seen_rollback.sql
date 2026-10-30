-- Rollback for 20261031002000_member_feature_seen: removes the announcement memory and its two functions. Safe to run
-- with rows present: they only record that a member has seen a launch announcement, so after a rollback (and a later
-- re-apply) members would simply see the Ask The Plug intro once more. Audit rows already written are kept.
DROP FUNCTION IF EXISTS public.member_feature_mark_seen(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.member_features_seen(uuid);
DROP TABLE IF EXISTS public.member_feature_seen;
