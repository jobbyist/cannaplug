// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  updates: [] as { patch: Record<string, unknown>; id: string }[],
  inserts: [] as Record<string, unknown>[],
  assertRole: vi.fn(),
  fetchArticleImagesFn: vi.fn(),
  hideArticleCommentFn: vi.fn(),
  listRecentCommentsFn: vi.fn(),
}));

vi.mock("@/lib/admin-data.server", () => ({ assertRole: h.assertRole }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({ lte: async () => ({ data: h.rows, error: null }) }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_c: string, id: string) => {
          h.updates.push({ patch, id });
          return { error: null };
        },
      }),
      insert: async (row: Record<string, unknown>) => {
        h.inserts.push({ table, ...row });
        return { error: null };
      },
    }),
  },
}));
vi.mock("@/lib/journal.functions", () => ({
  fetchArticleImagesFn: h.fetchArticleImagesFn,
  hideArticleCommentFn: h.hideArticleCommentFn,
  listRecentCommentsFn: h.listRecentCommentsFn,
}));

import { NewsroomPanel } from "@/components/admin/NewsroomPanel";
import { fetchArticleImages } from "@/lib/journal-engagement.server";
import type { FetchLike } from "@/lib/journal-images";

const photo = (id: string) => ({
  id,
  alt_description: "x",
  urls: { raw: `https://images.unsplash.com/photo-${id}` },
  user: { name: "P", links: { html: "https://unsplash.com/@p" } },
  links: { download_location: `https://api.unsplash.com/photos/${id}/download` },
});
let seq = 0;
const unsplash: FetchLike = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ results: [photo(String(++seq))] }),
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.rows = [];
  h.updates = [];
  h.inserts = [];
});

describe("fetchArticleImages (admin action)", () => {
  const queries = [
    { role: "cover", query: "a", alt: "Cover alt text" },
    { role: "inline", query: "b", alt: "Inline alt text", after_section: 2 },
  ];

  it("needs a manager, and says so plainly when the Unsplash key is missing", async () => {
    h.assertRole.mockRejectedValueOnce(new Error("forbidden"));
    await expect(fetchArticleImages("u", { UNSPLASH_ACCESS_KEY: "k" }, unsplash)).rejects.toThrow(
      "forbidden",
    );
    h.assertRole.mockResolvedValueOnce(undefined);
    await expect(fetchArticleImages("u", {}, unsplash)).rejects.toThrow(/UNSPLASH_ACCESS_KEY/);
    expect(h.updates).toEqual([]);
  });

  it("fills a missing cover and inline photos, keeps existing ones, and audits the run", async () => {
    h.assertRole.mockResolvedValue(undefined);
    h.rows = [
      { id: "1", slug: "new", cover_image_url: null, inline_images: [], image_queries: queries },
      {
        id: "2",
        slug: "done",
        cover_image_url: "https://images.unsplash.com/keep",
        inline_images: [
          { url: "u", alt: "a", credit_name: "c", credit_url: "x", after_section: 2 },
        ],
        image_queries: queries,
      },
      { id: "3", slug: "old", cover_image_url: null, inline_images: [], image_queries: [] },
    ];
    const r = await fetchArticleImages("u", { UNSPLASH_ACCESS_KEY: "k" }, unsplash);
    expect(r.articles).toEqual([
      { slug: "new", cover: true, inline: 1, missing: [] },
      { slug: "done", cover: true, inline: 1, missing: [] },
    ]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.id).toBe("1");
    expect(h.updates[0]!.patch).toMatchObject({
      cover_alt: "Cover alt text",
      cover_credit_name: "P",
    });
    expect(String(h.updates[0]!.patch["cover_image_url"])).toMatch(
      /^https:\/\/images\.unsplash\.com\//,
    );
    expect(h.inserts[0]).toMatchObject({ action: "journal_images_fetched", actor_user_id: "u" });
  });
});

describe("Newsroom admin panel", () => {
  it("lists comments, hides one with a reason, and shows the photo report", async () => {
    h.listRecentCommentsFn.mockResolvedValue([
      {
        id: "c1",
        name: "Thandi M.",
        body: "Nice",
        isSeed: true,
        hidden: false,
        article: { title: "T1", slug: "t1" },
      },
    ]);
    h.hideArticleCommentFn.mockResolvedValue({});
    h.fetchArticleImagesFn.mockResolvedValue({
      articles: [{ slug: "t1", cover: true, inline: 2, missing: ["q"] }],
    });
    window.prompt = vi.fn().mockReturnValue("off topic");
    const user = userEvent.setup();
    render(<NewsroomPanel />);
    expect(await screen.findByText(/\(seeded\)/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Hide/ }));
    await waitFor(() =>
      expect(h.hideArticleCommentFn).toHaveBeenCalledWith({
        data: { commentId: "c1", reason: "off topic" },
      }),
    );
    await user.click(screen.getByRole("button", { name: /Fetch article images/ }));
    const list = await screen.findByLabelText("Photo results");
    expect(list.textContent).toMatch(/t1.*cover ✓, 2 inline photos.*no result for: q/);
  });

  it("shows the reason when fetching fails", async () => {
    h.listRecentCommentsFn.mockResolvedValue([]);
    h.fetchArticleImagesFn.mockRejectedValue(new Error("UNSPLASH_ACCESS_KEY is not set in Vercel"));
    render(<NewsroomPanel />);
    await userEvent.click(await screen.findByRole("button", { name: /Fetch article images/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/UNSPLASH_ACCESS_KEY/);
  });
});
