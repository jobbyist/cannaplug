/**
 * Live ZAR→USD pricing for PayPal (PayPal cannot charge ZAR).
 *
 * The market rate comes from public reference-rate feeds, a safety margin is applied in the merchant's
 * favour (covers PayPal's conversion spread and intraday movement), and the result is recorded in
 * `fx_rates` with a short validity. `payment_initiate` then snapshots that rate into the transaction,
 * so the amount the member sees, PayPal charges and the webhook is checked against are all one number.
 *
 * Pure and dependency-injected so it is unit-testable without the network.
 */

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface MarketRate {
  zarPerUsd: number;
  source: string;
}

const MIN_ZAR_PER_USD = 5;
const MAX_ZAR_PER_USD = 60;
/** Two independent feeds must agree this closely, or we refuse to price off either. */
const MAX_FEED_DISAGREEMENT = 0.03;
export const LIVE_RATE_VALID_MINUTES = 30;

const inBounds = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= MIN_ZAR_PER_USD && n <= MAX_ZAR_PER_USD;

async function getJson(fetchFn: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** ECB reference rates via Frankfurter: USD per 1 ZAR, inverted to ZAR per USD. */
async function frankfurter(fetchFn: FetchLike, timeoutMs: number): Promise<MarketRate> {
  const body = (await getJson(
    fetchFn,
    "https://api.frankfurter.dev/v1/latest?base=ZAR&symbols=USD",
    timeoutMs,
  )) as {
    rates?: { USD?: number };
  };
  const usdPerZar = body?.rates?.USD;
  if (typeof usdPerZar !== "number" || !(usdPerZar > 0)) throw new Error("bad payload");
  return { zarPerUsd: 1 / usdPerZar, source: "frankfurter.dev (ECB)" };
}

/** ExchangeRate-API open endpoint: ZAR per 1 USD. */
async function erApi(fetchFn: FetchLike, timeoutMs: number): Promise<MarketRate> {
  const body = (await getJson(fetchFn, "https://open.er-api.com/v6/latest/USD", timeoutMs)) as {
    result?: string;
    rates?: { ZAR?: number };
  };
  const zar = body?.rates?.ZAR;
  if (body?.result !== "success" || typeof zar !== "number") throw new Error("bad payload");
  return { zarPerUsd: zar, source: "open.er-api.com" };
}

/**
 * Fetches the market rate. Uses every feed that answers; if two answer they must agree (then the
 * more conservative = lower ZAR-per-USD, i.e. higher USD price, is used). Throws if none is usable.
 */
export async function fetchMarketRate(fetchFn: FetchLike, timeoutMs = 4000): Promise<MarketRate> {
  const settled = await Promise.allSettled([
    frankfurter(fetchFn, timeoutMs),
    erApi(fetchFn, timeoutMs),
  ]);
  const ok = settled
    .filter((s): s is PromiseFulfilledResult<MarketRate> => s.status === "fulfilled")
    .map((s) => s.value)
    .filter((r) => inBounds(r.zarPerUsd));
  if (ok.length === 0) throw new Error("fx_feed_unavailable");
  if (ok.length === 2) {
    const [a, b] = ok as [MarketRate, MarketRate];
    if (
      Math.abs(a.zarPerUsd - b.zarPerUsd) / Math.min(a.zarPerUsd, b.zarPerUsd) >
      MAX_FEED_DISAGREEMENT
    ) {
      throw new Error("fx_feeds_disagree");
    }
    const lower = a.zarPerUsd <= b.zarPerUsd ? a : b;
    return { zarPerUsd: lower.zarPerUsd, source: `${a.source} + ${b.source}` };
  }
  return ok[0]!;
}

/** Margin in the merchant's favour: fewer rand per dollar means the member is charged slightly more USD. */
export function applyMargin(zarPerUsd: number, marginPercent: number): number {
  const m = Math.min(Math.max(Number.isFinite(marginPercent) ? marginPercent : 4, 0), 10);
  return Math.round(zarPerUsd * (1 - m / 100) * 1e6) / 1e6;
}

export interface FxDeps {
  fetch: FetchLike;
  now(): number;
  settings(): Promise<{ mode: "live" | "manual"; marginPercent: number; refreshSeconds: number }>;
  /** Latest rate row that is still valid, if any. `live` = recorded by this module (no human setter). */
  latestValid(): Promise<{ createdAtMs: number; live: boolean } | null>;
  record(rate: number, validMinutes: number, source: string): Promise<void>;
  warn?(msg: string, err?: unknown): void;
}

/**
 * Called before PayPal initiation. Guarantees a current rate exists, refreshing from the market when the
 * newest live one is older than the refresh window. A failed refresh falls back to any still-valid rate;
 * with none at all it throws `fx_rate_unavailable` and the PayPal option is declined (Yoco is unaffected).
 */
export async function ensureFreshRate(deps: FxDeps): Promise<{ refreshed: boolean }> {
  const cfg = await deps.settings();
  const latest = await deps.latestValid();
  if (cfg.mode === "manual") {
    if (!latest) throw new Error("fx_rate_unavailable: manual mode and no current rate");
    return { refreshed: false };
  }
  if (latest?.live && deps.now() - latest.createdAtMs < cfg.refreshSeconds * 1000)
    return { refreshed: false };
  try {
    const market = await fetchMarketRate(deps.fetch);
    const rate = applyMargin(market.zarPerUsd, cfg.marginPercent);
    await deps.record(
      rate,
      LIVE_RATE_VALID_MINUTES,
      `live: ${market.source} market ${market.zarPerUsd.toFixed(4)} less ${cfg.marginPercent}% margin`,
    );
    return { refreshed: true };
  } catch (err) {
    deps.warn?.("live FX refresh failed", err);
    if (latest) return { refreshed: false };
    throw new Error("fx_rate_unavailable: no live feed and no current rate");
  }
}
