import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@/lib/ai/gemini";
import {
  TOPIC_SEEDS,
  batchTimestamps,
  dailyRunAllowed,
  parseDraft,
  research,
  sastDate,
  slugify,
  writeArticle,
  type FirecrawlFetch,
} from "@/lib/newsroom/pipeline";

const body = (words = 1500) =>
  `## Section one\n\n${"word ".repeat(words)}\n\n## The Takeaway\n\nDone.`;
const draft = (over: Record<string, unknown> = {}) => ({
  title: "A good title for the Journal",
  excerpt: "x".repeat(150),
  category: "Culture",
  keywords: ["a", "b", "c", "d", "e"],
  unsplash_query: "pretoria skyline",
  body_md: body(),
  ...over,
});
const gem = (texts: string[]) => {
  let i = 0;
  const f = vi.fn<FetchLike>(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: texts[Math.min(i++, texts.length - 1)] }] } }],
      }),
  }));
  return f;
};

describe("parseDraft", () => {
  it("accepts a valid article and normalises category/keywords", () => {
    const d = parseDraft(
      "here you go " + JSON.stringify(draft({ category: "Nonsense", keywords: ["a", 3, "b"] })),
    );
    expect(d.category).toBe("Culture");
    expect(d.keywords).toEqual(["a", "b"]);
  });
  it("rejects short bodies, H1s, bad titles and excerpts, and non-JSON", () => {
    for (const bad of [
      draft({ body_md: "short" }),
      draft({ body_md: "# H1\n" + body() }),
      draft({ title: "" }),
      draft({ title: "x".repeat(200) }),
      draft({ excerpt: "tiny" }),
    ])
      expect(() => parseDraft(JSON.stringify(bad))).toThrow();
    expect(() => parseDraft("no json here")).toThrow();
  });
});

describe("research (Firecrawl)", () => {
  it("returns usable sources only: http(s) URLs with enough text", async () => {
    const f: FirecrawlFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          web: [
            { url: "https://a.example/1", title: "A", markdown: "m".repeat(500) },
            { url: "javascript:alert(1)", title: "bad", markdown: "m".repeat(500) },
            { url: "https://a.example/2", title: "short", markdown: "tiny" },
            { url: "https://a.example/3", description: "d".repeat(300) },
          ],
        },
      }),
    });
    const s = await research(f, "key", "q");
    expect(s.map((x) => x.url)).toEqual(["https://a.example/1", "https://a.example/3"]);
  });
  it("sends the bearer key and surfaces failures", async () => {
    const f = vi.fn<FirecrawlFetch>(async () => ({
      ok: false,
      status: 402,
      json: async () => ({}),
    }));
    await expect(research(f, "fc-key", "q")).rejects.toThrow("402");
    expect(f.mock.calls[0]![1].headers["Authorization"]).toBe("Bearer fc-key");
  });
});

describe("writeArticle (gemini-2.5-flash, two passes)", () => {
  const sources = Array.from({ length: 4 }, (_, i) => ({
    url: `https://s.example/${i}`,
    title: `S${i}`,
    content: "c".repeat(300),
  }));
  it("drafts then edits, using the editor's version when it is valid", async () => {
    const f = gem([
      JSON.stringify(draft({ title: "Draft title" })),
      JSON.stringify(draft({ title: "Edited title" })),
    ]);
    const a = await writeArticle(f, "k", sources, ["old headline"]);
    expect(a.title).toBe("Edited title");
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0]![0]).toContain("gemini-2.5-flash");
    const first = JSON.parse(f.mock.calls[0]![1].body);
    expect(first.contents[0].parts[0].text).toContain("old headline");
    expect(first.generationConfig.responseMimeType).toBe("application/json");
  });
  it("falls back to the draft when the editor pass is invalid or unavailable", async () => {
    expect(
      (
        await writeArticle(
          gem([JSON.stringify(draft({ title: "Draft only" })), "garbage"]),
          "k",
          sources,
          [],
        )
      ).title,
    ).toBe("Draft only");
    const down = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify(draft({ title: "Draft only" })) }] } },
            ],
          }),
      })
      .mockResolvedValue({ ok: false, status: 503, text: async () => "{}" });
    expect((await writeArticle(down, "k", sources, [])).title).toBe("Draft only");
  });
  it("a bad first draft fails the run (nothing is published)", async () => {
    await expect(writeArticle(gem(["nope"]), "k", sources, [])).rejects.toThrow();
  });
  it("tells the model that research text is untrusted", async () => {
    const f = gem([JSON.stringify(draft()), JSON.stringify(draft())]);
    await writeArticle(f, "k", sources, []);
    expect(JSON.parse(f.mock.calls[0]![1].body).systemInstruction.parts[0].text).toMatch(
      /untrusted/i,
    );
  });
});

describe("scheduling helpers (06:00 SAST = 04:00 UTC)", () => {
  it("SAST is UTC+2", () => {
    expect(sastDate(Date.UTC(2026, 9, 2, 22, 30))).toBe("2026-10-03");
    expect(sastDate(Date.UTC(2026, 9, 2, 4, 0))).toBe("2026-10-02");
  });
  it("the daily run is idempotent within 18 hours and allowed after a day", () => {
    const now = Date.UTC(2026, 9, 3, 4, 0);
    expect(dailyRunAllowed(null, now)).toBe(true);
    expect(dailyRunAllowed(now - 60_000, now)).toBe(false);
    expect(dailyRunAllowed(now - 17 * 3_600_000, now)).toBe(false);
    expect(dailyRunAllowed(now - 24 * 3_600_000, now)).toBe(true);
  });
  it("a same-day batch gets distinct, ordered timestamps ending now", () => {
    const now = Date.UTC(2026, 9, 2, 10, 0);
    const t = batchTimestamps(3, now);
    expect(t).toHaveLength(3);
    expect(new Set(t).size).toBe(3);
    expect(t[2]).toBe(new Date(now).toISOString());
    expect([...t].sort()).toEqual(t);
  });
  it("slugs are url-safe and bounded; topics are South African", () => {
    expect(slugify("Hello, World! — Cannabis & Culture")).toBe("hello-world-cannabis-culture");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(70);
    expect(TOPIC_SEEDS.length).toBeGreaterThanOrEqual(10);
  });
});
