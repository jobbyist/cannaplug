-- Rollback for 20261031006000_plug_back: removes the Plug Back functions, the void trigger and the tube ledger.
-- Free pre-roll sales already rung up stay as ordinary R0 sales; only the tube counts are lost, so export
-- plug_back_ledger first if the counts matter.
DROP TRIGGER IF EXISTS pos_sales_plug_back_void ON public.pos_sales;
DROP FUNCTION IF EXISTS public._plug_back_void_restore();
DROP FUNCTION IF EXISTS public.plug_back_redeem(uuid, uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.plug_back_record_return(uuid, uuid, integer, text, text);
DROP FUNCTION IF EXISTS public.plug_back_summary(uuid, uuid);
DROP FUNCTION IF EXISTS public._plug_back_lock(uuid);
DROP FUNCTION IF EXISTS public._plug_back_balance(uuid);
DROP FUNCTION IF EXISTS public._plug_back_eligible(uuid);
DROP FUNCTION IF EXISTS public.plug_back_tubes_per_reward();
DROP TABLE IF EXISTS public.plug_back_ledger;
DROP FUNCTION IF EXISTS public._plug_back_append_only();
