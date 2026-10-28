-- Rollback for 20261029003000_loyalty_sources: restores the old constraints. Refused while any ledger row uses a new
-- source type, or a referral code contains an underscore (they would no longer pass).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions
             WHERE source_type IN ('pos_reward', 'pos_reward_void', 'referral', 'points_conversion'))
     OR EXISTS (SELECT 1 FROM public.member_signup_details WHERE referral_code ~ '_') THEN
    RAISE EXCEPTION 'rollback_blocked: rewards, referrals or point conversions are recorded; keep this migration';
  END IF;
END $$;

ALTER TABLE public.loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_source_type_check;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_source_type_check CHECK (source_type IN (
  'order', 'order_cancel', 'order_redeem', 'order_redeem_release', 'pos_sale', 'pos_sale_void', 'pos_refund'));
ALTER TABLE public.loyalty_transactions DROP CONSTRAINT IF EXISTS loyalty_transactions_source_link_chk;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_source_link_chk CHECK (
  (source_type LIKE 'order%' AND order_id = source_id)
  OR (source_type LIKE 'pos\_%' AND pos_sale_id IS NOT NULL));
ALTER TABLE public.member_signup_details DROP CONSTRAINT IF EXISTS member_signup_details_referral_code_check;
ALTER TABLE public.member_signup_details ADD CONSTRAINT member_signup_details_referral_code_check
  CHECK (referral_code IS NULL OR referral_code ~ '^[A-Z0-9-]{3,32}$');
