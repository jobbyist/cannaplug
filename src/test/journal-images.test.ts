import { describe, expect, it, vi } from "vitest";
import {
  photoUrl,
  pickArticleImages,
  pickUnsplashPhoto,
  type FetchLike,
} from "@/lib/journal-images";

const photo = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  alt_description: `alt ${id}`,
  urls: { raw: `https://images.unsplash.com/photo-${id}?ixid=abc` },
  user: { name: `Photographer ${id}`, links: { html: `https://unsplash.com/@p${id}` } },
  links: { download_location: `https://api.unsplash.com/photos/${id}/download` },
  ...over,
});
const api = (results: unknown[]): FetchLike & { calls: string[] } => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ results }) };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
};

describe("Unsplash picking", () => {
  it("sizes the raw URL, credits the photographer with a UTM link and pings download_location", async () => {
    const f = api([photo("1")]);
    const p = await pickUnsplashPhoto(f, "KEY", "lemon peel", 1600, new Set());
    expect(p).toMatchObject({ id: "1", credit_name: "Photographer 1" });
    expect(p!.url).toBe(
      "https://images.unsplash.com/photo-1?ixid=abc&w=1600&q=80&fit=crop&auto=format",
    );
    expect(p!.credit_url).toBe("https://unsplash.com/@p1?utm_source=cannaplug&utm_medium=referral");
    expect(f.calls[0]).toContain("query=lemon%20peel");
    expect(f.calls[1]).toBe("https://api.unsplash.com/photos/1/download");
    expect(photoUrl("https://images.unsplash.com/x", 800)).toContain("x?w=800");
  });

  it("never repeats a photo, ignores results hosted anywhere else, and survives failures", async () => {
    const used = new Set<string>();
    const f = api([
      photo("1"),
      photo("2", { urls: { raw: "https://evil.example/p.jpg" } }),
      photo("3"),
    ]);
    expect((await pickUnsplashPhoto(f, "K", "q", 1200, used))!.id).toBe("1");
    expect((await pickUnsplashPhoto(f, "K", "q", 1200, used))!.id).toBe("3");
    expect(await pickUnsplashPhoto(f, "K", "q", 1200, used)).toBeNull();
    const down: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
    expect(await pickUnsplashPhoto(down, "K", "q", 1200, new Set())).toBeNull();
  });

  it("fills a cover and the inline photos, keeps what is already there, and reports misses", async () => {
    const f = vi.fn(api([photo("1"), photo("2"), photo("3")]));
    const queries = [
      { role: "cover" as const, query: "a", alt: "Cover alt text here" },
      { role: "inline" as const, query: "b", alt: "Inline one alt text", after_section: 1 },
      { role: "inline" as const, query: "c", alt: "Inline two alt text", after_section: 3 },
    ];
    const r = await pickArticleImages(
      f as unknown as FetchLike,
      "K",
      queries,
      { hasCover: false, inlineAfter: [] },
      new Set(),
    );
    expect(r.cover?.alt).toBe("Cover alt text here");
    expect(r.inline.map((i) => i.after_section)).toEqual([1, 3]);
    expect(r.missing).toEqual([]);
    const again = await pickArticleImages(
      api([photo("9")]),
      "K",
      queries,
      { hasCover: true, inlineAfter: [1, 3] },
      new Set(),
    );
    expect(again).toEqual({ cover: null, inline: [], missing: [] });
    const none = await pickArticleImages(
      api([]),
      "K",
      queries,
      { hasCover: false, inlineAfter: [] },
      new Set(),
    );
    expect(none.missing).toEqual(["a", "b", "c"]);
  });
});
