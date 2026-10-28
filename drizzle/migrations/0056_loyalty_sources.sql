-- 29 Oct 2026: the loyalty ledger learns three new kinds of entry, and referral codes may contain an underscore.
--   * loyalty_transactions.source_type gains 'pos_reward' (points spent on a free reward at the till),
--     'pos_reward_void' (points given back when that sale is voided), 'referral' (the point a member earns when a
--     friend they referred signs up and spends R50) and 'points_conversion' (the one-off conversion of points earned
--     at the old rate of 1 point per R10 to the new rate of 1 point per R50).
--   * the source link rule accepts 'referral' and 'points_conversion', which are not tied to an order or a sale.
--   * member_signup_details.referral_code accepts underscores, so any username can be used as a referral code.
-- This file only replaces CHECK constraints (it contains DROP CONSTRAINT statements, so the Supabase connector asks
-- for confirmation; run it in the SQL editor if the prompt times out). Nothing is deleted.

ALTER TABLE public.loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_source_type_check;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_source_type_check CHECK (source_type IN (
  'order', 'order_cancel', 'order_redeem', 'order_redeem_release',
  'pos_sale', 'pos_sale_void', 'pos_refund',
  'pos_reward', 'pos_reward_void', 'referral', 'points_conversion'));

ALTER TABLE public.loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_source_link_chk;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_source_link_chk CHECK (
  (source_type LIKE 'order%' AND order_id = source_id)
  OR (source_type LIKE 'pos\_%' AND pos_sale_id IS NOT NULL)
  OR source_type IN ('referral', 'points_conversion'));

ALTER TABLE public.member_signup_details DROP CONSTRAINT IF EXISTS member_signup_details_referral_code_check;
ALTER TABLE public.member_signup_details ADD CONSTRAINT member_signup_details_referral_code_check
  CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z0-9_-]{3,32}$');
