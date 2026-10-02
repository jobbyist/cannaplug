import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureFreshRate, type FxDeps } from "./fx";

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function deps(): FxDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    warn: (msg, err) => console.warn(`[fx] ${msg}`, err instanceof Error ? err.message : err),
    async settings() {
      const { data, error } = await supabaseAdmin
        .from("payment_settings")
        .select("key,value")
        .in("key", ["fx_mode", "fx_margin_percent", "fx_refresh_seconds"]);
      if (error) throw new Error(error.message);
      const m = new Map((data ?? []).map((r) => [r.key, r.value]));
      return {
        mode: m.get("fx_mode") === "manual" ? "manual" : "live",
        marginPercent: num(m.get("fx_margin_percent"), 4),
        refreshSeconds: num(m.get("fx_refresh_seconds"), 600),
      };
    },
    async latestValid() {
      const { data, error } = await supabaseAdmin
        .from("fx_rates")
        .select("created_at,set_by")
        .eq("base_currency", "ZAR")
        .eq("quote_currency", "USD")
        .gt("valid_until", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { createdAtMs: Date.parse(data.created_at), live: data.set_by === null } : null;
    },
    async record(rate, validMinutes, source) {
      const { error } = await supabaseAdmin.rpc("fx_record_live_rate", {
        p_base: "ZAR",
        p_quote: "USD",
        p_rate: rate,
        p_valid_minutes: validMinutes,
        p_source: source,
      });
      if (error) throw new Error(error.message);
    },
  };
}

/** Call immediately before `payment_initiate` for PayPal. */
export const ensureLiveFxRate = () => ensureFreshRate(deps());
