import { describe, expect, it, vi } from "vitest";
import {
  GeminiError,
  generate,
  generateWithRetry,
  isModelId,
  type FetchLike,
} from "@/lib/ai/gemini";
import { DEFAULT_MODELS, modelLadder, plugModels, MAX_MODEL_ATTEMPTS } from "@/lib/ai/plug-models";
import {
  jobModelConfig,
  memberAllowance,
  modelDayBucket,
  nextPacificMidnight,
  pacificDate,
  quotaConfig,
  quotaMessage,
  takeJobQuota,
  takeMemberQuota,
  takeModelSlot,
} from "@/lib/ai/quota";
import { memQuota } from "./ai-quota-fixtures";
import { SITE_FACTS } from "@/lib/ai/chat-prompt";

const ok = (text: string) => async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
});
const status = (s: number) => async () => ({ ok: false, status: s, text: async () => "{}" });

const T = Date.UTC(2026, 9, 30, 10, 0); // 12:00 SAST, 03:00 PDT
const base = {
  apiKey: "k",
  model: "gemini-3.5-flash-lite",
  system: "s",
  turns: [{ role: "user" as const, content: "x" }],
};

describe("Gemini client", () => {
  it("Gemini 3.x: thinking LEVEL, JSON + schema, default temperature, key in a header only, thoughts hidden", async () => {
    const f = vi.fn<FetchLike>(ok('{"reply":"Howzit"}'));
    const out = await generate(f, {
      ...base,
      apiKey: "KEY123",
      model: "gemini-3.8-flash",
      json: true,
      schema: { type: "OBJECT" },
      thinkingLevel: "medium",
      turns: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
        { role: "user", content: "again" },
      ],
    });
    expect(out).toEqual({ text: '{"reply":"Howzit"}', usage: { input: 10, output: 5 } });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(url).not.toContain("KEY123");
    expect(init.headers["x-goog-api-key"]).toBe("KEY123");
    const body = JSON.parse(init.body);
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" }); // never both (Google: 400)
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema).toEqual({ type: "OBJECT" });
    expect(body.generationConfig).not.toHaveProperty("temperature");
  });
  it("Gemini 2.5 (Journal): thinking BUDGET 0 and the caller's temperature", async () => {
    const f = vi.fn<FetchLike>(ok("x"));
    await generate(f, { ...base, model: "gemini-2.5-flash", temperature: 0.7 });
    const body = JSON.parse(f.mock.calls[0]![1].body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(body.generationConfig.temperature).toBe(0.7);
  });
  it("refuses a model id that is not a Gemini id (it would become part of the URL)", async () => {
    const f = vi.fn<FetchLike>(ok("x"));
    await expect(generate(f, { ...base, model: "../../evil" })).rejects.toMatchObject({
      status: 400,
    });
    expect(f).not.toHaveBeenCalled();
    expect(isModelId("gemini-3.5-flash-lite")).toBe(true);
    expect(isModelId("gpt-4")).toBe(false);
  });
  it("classifies errors: 429/5xx/network transient, 400/403 not; blocked prompts are not retried", async () => {
    await expect(generate(status(429), base)).rejects.toMatchObject({
      status: 429,
      transient: true,
    });
    await expect(generate(status(503), base)).rejects.toMatchObject({ transient: true });
    await expect(generate(status(403), base)).rejects.toMatchObject({
      status: 403,
      transient: false,
    });
    await expect(
      generate(async () => {
        throw new Error("ECONNRESET");
      }, base),
    ).rejects.toMatchObject({ status: 0, transient: true });
    const blocked: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }),
    });
    await expect(generate(blocked, base)).rejects.toMatchObject({ transient: false });
  });
  it("retries once for a transient 5xx but never for 429 (that would spend more quota)", async () => {
    const flaky = vi
      .fn<FetchLike>()
      .mockImplementationOnce(status(503))
      .mockImplementation(ok("fine"));
    expect((await generateWithRetry(flaky, base, async () => undefined)).text).toBe("fine");
    expect(flaky).toHaveBeenCalledTimes(2);
    const limited = vi.fn<FetchLike>(status(429));
    await expect(generateWithRetry(limited, base, async () => undefined)).rejects.toBeInstanceOf(
      GeminiError,
    );
    expect(limited).toHaveBeenCalledTimes(1);
  });
});

describe("model ladder (Gemini free tier, per model)", () => {
  it("defaults: 3.8 Flash for deep matches, 3.5 Flash-Lite to chat, 3.1 Flash-Lite as fallback, guards under Google's limits", () => {
    const m = plugModels({});
    expect(m.reasoning).toMatchObject({ id: "gemini-3.8-flash", rpm: 4, rpd: 18 }); // free tier 5 / 20
    expect(m.chat).toMatchObject({ id: "gemini-3.5-flash-lite", rpm: 8, rpd: 450 }); // free tier 10 / 500
    expect(m.fallback).toMatchObject({ id: "gemini-3.1-flash-lite", rpm: 8, rpd: 450 }); // free tier 10 / 500
    expect(DEFAULT_MODELS.reasoning.rpd).toBeLessThan(20);
  });
  it("env overrides are honoured only when they are valid", () => {
    const m = plugModels({
      PLUG_CHAT_MODEL: "gemini-4-flash",
      PLUG_CHAT_RPD: "900",
      PLUG_REASONING_MODEL: "../../evil",
      PLUG_REASONING_RPM: "-3",
    });
    expect(m.chat).toMatchObject({ id: "gemini-4-flash", rpd: 900 });
    expect(m.reasoning).toMatchObject({ id: "gemini-3.8-flash", rpm: 4 });
  });
  it("chat never touches the reasoning model; a match prefers it; the same model is never listed twice", () => {
    const m = plugModels({});
    expect(modelLadder(m, "chat").map((x) => x.id)).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ]);
    expect(modelLadder(m, "match").map((x) => x.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ]);
    const same = plugModels({ PLUG_FALLBACK_MODEL: "gemini-3.5-flash-lite" });
    expect(modelLadder(same, "chat")).toHaveLength(1);
    expect(MAX_MODEL_ATTEMPTS).toBe(2);
  });
});

describe("free-tier quota", () => {
  const cfg = quotaConfig({});
  const who = (userId = "u1", ip = "ip1", s = "s1") => ({ userId, ipHash: ip, sessionId: s });

  it("defaults: 25 messages and 3 deep matches per member per day; env can change them", () => {
    expect(cfg).toMatchObject({
      memberPerDay: 25,
      memberMatchesPerDay: 3,
      ipPerHour: 30,
      sessionTotal: 40,
    });
    expect(quotaConfig({ CHAT_MEMBER_RPD: "10", PLUG_MEMBER_MATCH_RPD: "1" })).toMatchObject({
      memberPerDay: 10,
      memberMatchesPerDay: 1,
    });
  });
  it("uses Pacific time for the daily window (Google resets at midnight PT)", () => {
    expect(pacificDate(Date.UTC(2026, 9, 30, 6, 59))).toBe("2026-10-29");
    expect(pacificDate(Date.UTC(2026, 9, 30, 7, 0))).toBe("2026-10-30");
    expect(new Date(nextPacificMidnight(T)).toISOString()).toBe("2026-10-31T07:00:00.000Z");
  });
  it("a member is capped per day; deep matches have their own smaller cap", async () => {
    const { db } = memQuota();
    for (let i = 0; i < 3; i++)
      expect((await takeMemberQuota(db, cfg, who(), "match", T)).ok).toBe(true);
    expect(await takeMemberQuota(db, cfg, who(), "match", T)).toMatchObject({
      ok: false,
      reason: "matches",
    });
    expect((await takeMemberQuota(db, cfg, who(), "chat", T)).ok).toBe(true); // chat still allowed
    const { db: d2 } = memQuota();
    for (let i = 0; i < 25; i++)
      await takeMemberQuota(d2, cfg, who("u2", `ip${i}`, `s${i}`), "chat", T);
    expect(await takeMemberQuota(d2, cfg, who("u2", "ipX", "sX"), "chat", T)).toMatchObject({
      ok: false,
      reason: "member",
    });
  });
  it("per IP per hour and per session caps hold, and a refused member spends nothing further", async () => {
    const { db, counts } = memQuota();
    for (let i = 0; i < 30; i++)
      await takeMemberQuota(db, cfg, who(`u${i}`, "same-ip", `s${i}`), "chat", T);
    expect(await takeMemberQuota(db, cfg, who("u99", "same-ip", "s99"), "chat", T)).toMatchObject({
      reason: "visitor",
    });
    expect(counts.get("chat:session:s99")).toBeUndefined();
    const { db: d2 } = memQuota();
    for (let i = 0; i < 40; i++)
      await takeMemberQuota(d2, cfg, who(`m${i}`, `i${i}`, "one-session"), "chat", T);
    expect(
      await takeMemberQuota(d2, cfg, who("m99", "i99", "one-session"), "chat", T),
    ).toMatchObject({
      reason: "session",
    });
  });
  it("each model has its own minute and day slots; a busy minute never spends the day", async () => {
    const { db, counts } = memQuota();
    const m = { id: "gemini-3.8-flash", rpm: 2, rpd: 3 };
    expect(await takeModelSlot(db, m, T)).toBe("ok");
    expect(await takeModelSlot(db, m, T)).toBe("ok");
    expect(await takeModelSlot(db, m, T)).toBe("busy");
    expect(counts.get(modelDayBucket(m.id, T))).toBe(2);
    expect(await takeModelSlot(db, m, T + 60_000)).toBe("ok");
    expect(await takeModelSlot(db, m, T + 120_000)).toBe("daily");
    // another model is unaffected
    expect(await takeModelSlot(db, { id: "gemini-3.5-flash-lite", rpm: 8, rpd: 450 }, T)).toBe(
      "ok",
    );
  });
  it("the Journal keeps its own guard on its own model (gemini-2.5-flash), so chat can never starve it", async () => {
    const { db } = memQuota();
    const job = jobModelConfig({}, "gemini-2.5-flash");
    expect(job).toEqual({ id: "gemini-2.5-flash", rpm: 8, rpd: 180 });
    for (let i = 0; i < 450; i++)
      await takeModelSlot(db, { id: "gemini-3.5-flash-lite", rpm: 1e6, rpd: 450 }, T);
    expect(await takeJobQuota(db, job, T)).toBe(true);
  });
  it("reports what a member has left", async () => {
    const { db } = memQuota();
    await takeMemberQuota(db, cfg, who(), "match", T);
    expect(await memberAllowance(db, cfg, "u1", T)).toEqual({
      limit: 25,
      remaining: 24,
      matchLimit: 3,
      matchesRemaining: 2,
      resetsAt: "2026-10-31T07:00:00.000Z",
    });
  });
  it("every refusal has a friendly message; the long ones name a human way to reach the team", () => {
    for (const reason of ["member", "session", "daily"] as const)
      expect(quotaMessage({ ok: false, reason, retryAfterMinutes: 5, resetsAt: T })).toContain(
        SITE_FACTS.phone,
      );
    expect(
      quotaMessage({ ok: false, reason: "matches", retryAfterMinutes: 5, resetsAt: T }),
    ).toMatch(/keep chatting/);
    expect(quotaMessage({ ok: false, reason: "busy", retryAfterMinutes: 1 })).toMatch(/minute/);
  });
});
