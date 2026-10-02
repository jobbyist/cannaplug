import { describe, expect, it, vi } from "vitest";
import { applyMargin, ensureFreshRate, fetchMarketRate, type FetchLike, type FxDeps } from "@/lib/payments/fx";

const feed = (frank: unknown, er: unknown): FetchLike => async (url) => {
  const body = url.includes("frankfurter") ? frank : er;
  if (body === "down") throw new Error("network");
  return { ok: true, status: 200, json: async () => body };
};
const FRANK = { rates: { USD: 0.05976 } }; // 16.733 ZAR/USD
const ER = { result: "success", rates: { ZAR: 16.74 } };

describe("fetchMarketRate", () => {
  it("inverts Frankfurter and uses the conservative of two agreeing feeds", async () => {
    const r = await fetchMarketRate(feed(FRANK, ER));
    expect(r.zarPerUsd).toBeCloseTo(16.7336, 3);
    expect(r.source).toContain("frankfurter");
  });
  it("works with one feed down", async () => {
    expect((await fetchMarketRate(feed("down", ER))).zarPerUsd).toBe(16.74);
    expect((await fetchMarketRate(feed(FRANK, "down"))).zarPerUsd).toBeCloseTo(16.7336, 3);
  });
  it("refuses when both are down, out of bounds, malformed, or they disagree", async () => {
    await expect(fetchMarketRate(feed("down", "down"))).rejects.toThrow("fx_feed_unavailable");
    await expect(fetchMarketRate(feed({ rates: { USD: 0.5 } }, { result: "success", rates: { ZAR: 2 } }))).rejects.toThrow();
    await expect(fetchMarketRate(feed({}, { result: "error" }))).rejects.toThrow();
    await expect(fetchMarketRate(feed(FRANK, { result: "success", rates: { ZAR: 19.5 } }))).rejects.toThrow("fx_feeds_disagree");
  });
});

describe("applyMargin", () => {
  it("lowers rand-per-dollar so the member is never under-charged", () => {
    expect(applyMargin(16.7336, 2)).toBeCloseTo(16.3989, 3);
    expect(applyMargin(18, 0)).toBe(18);
    expect(applyMargin(18, 99)).toBe(16.2); // capped at 10%
    expect(applyMargin(18, NaN)).toBeCloseTo(17.64, 6);
  });
});

function mk(over: Partial<FxDeps> = {}, latest: { ageMs: number; live: boolean } | null = null) {
  const record = vi.fn(async () => undefined);
  const deps: FxDeps = {
    fetch: feed(FRANK, ER),
    now: () => 1_000_000_000,
    settings: async () => ({ mode: "live", marginPercent: 2, refreshSeconds: 600 }),
    latestValid: async () => (latest ? { createdAtMs: 1_000_000_000 - latest.ageMs, live: latest.live } : null),
    record,
    ...over,
  };
  return { deps, record };
}

describe("ensureFreshRate", () => {
  it("refreshes when there is no rate, recording market, margin and a short validity", async () => {
    const { deps, record } = mk();
    expect(await ensureFreshRate(deps)).toEqual({ refreshed: true });
    const [rate, minutes, source] = record.mock.calls[0] as unknown as [number, number, string];
    expect(rate).toBeCloseTo(16.3989, 3);
    expect(minutes).toBe(30);
    expect(source).toMatch(/market 16\.7336 less 2% margin/);
  });
  it("does not refetch inside the refresh window, but does after it, and over a manager rate", async () => {
    expect((await ensureFreshRate(mk({}, { ageMs: 60_000, live: true }).deps)).refreshed).toBe(false);
    expect((await ensureFreshRate(mk({}, { ageMs: 700_000, live: true }).deps)).refreshed).toBe(true);
    expect((await ensureFreshRate(mk({}, { ageMs: 1_000, live: false }).deps)).refreshed).toBe(true);
  });
  it("falls back to a still-valid rate when feeds fail; throws when there is none", async () => {
    const down = { fetch: feed("down", "down") };
    expect((await ensureFreshRate(mk(down, { ageMs: 900_000, live: true }).deps)).refreshed).toBe(false);
    await expect(ensureFreshRate(mk(down).deps)).rejects.toThrow("fx_rate_unavailable");
  });
  it("manual mode never calls the network", async () => {
    const f = vi.fn(feed(FRANK, ER));
    const manual = { settings: async () => ({ mode: "manual" as const, marginPercent: 2, refreshSeconds: 600 }), fetch: f };
    expect((await ensureFreshRate(mk(manual, { ageMs: 5, live: false }).deps)).refreshed).toBe(false);
    await expect(ensureFreshRate(mk(manual).deps)).rejects.toThrow("fx_rate_unavailable");
    expect(f).not.toHaveBeenCalled();
  });
});
