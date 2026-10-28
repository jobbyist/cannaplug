import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTHOR_NAME } from "@/lib/journal-launch-articles";
import { SCHEDULED_ARTICLES } from "@/lib/journal-scheduled-articles";
import { complianceViolations } from "@/lib/newsroom/pipeline";
import {
  buildScheduledArticlesMigration,
  MIGRATION_NAME,
} from "../../scripts/journal-scheduled-migration";

const root = new URL("../../", import.meta.url).pathname;

describe("scheduled journal articles", () => {
  it("are three, by Dithekgo M., one per day at 8:00 AM SAST on 29, 30 and 31 October 2026", () => {
    expect(AUTHOR_NAME).toBe("Dithekgo M.");
    expect(SCHEDULED_ARTICLES).toHaveLength(3);
    expect(SCHEDULED_ARTICLES.map((a) => a.published_at)).toEqual([
      "2026-10-29T08:00:00+02:00",
      "2026-10-30T08:00:00+02:00",
      "2026-10-31T08:00:00+02:00",
    ]);
    // 8 AM SAST is 06:00 UTC
    expect(SCHEDULED_ARTICLES.map((a) => new Date(a.published_at).toISOString())).toEqual([
      "2026-10-29T06:00:00.000Z",
      "2026-10-30T06:00:00.000Z",
      "2026-10-31T06:00:00.000Z",
    ]);
    expect(new Set(SCHEDULED_ARTICLES.map((a) => a.slug)).size).toBe(3);
  });

  it.each(SCHEDULED_ARTICLES.map((a) => [a.slug, a] as const))(
    "%s passes the compliance gate and has a proper structure",
    (_slug, a) => {
      expect(complianceViolations(a)).toEqual([]);
      expect(a.body_md).not.toMatch(/^# /m);
      expect(a.body_md.trimStart().startsWith("## ")).toBe(true);
      const h2 = a.body_md.match(/^## .+$/gm) ?? [];
      expect(h2.length).toBeGreaterThanOrEqual(5);
      expect(h2.at(-1)!.toLowerCase()).toContain("takeaway");
      expect(a.title.length).toBeLessThanOrEqual(75);
      expect(a.excerpt.length).toBeGreaterThanOrEqual(100);
      expect(a.excerpt.length).toBeLessThanOrEqual(200);
      expect(a.keywords.length).toBeGreaterThanOrEqual(5);
      expect(a.body_md.split(/\s+/).length).toBeGreaterThan(300);
      expect(a.image_queries.filter((q) => q.role === "cover")).toHaveLength(1);
      expect(a.image_queries.filter((q) => q.role === "inline")).toHaveLength(2);
      for (const q of a.image_queries) expect(q.alt.length).toBeGreaterThan(10);
      for (const q of a.image_queries.filter((x) => x.role === "inline"))
        expect(q.after_section).toBeLessThan(h2.length);
    },
  );
});

describe("the scheduled-articles migration", () => {
  it("is exactly what the generator writes, mirrored in drizzle, and inserts rows only", () => {
    const sql = buildScheduledArticlesMigration();
    expect(readFileSync(`${root}supabase/migrations/${MIGRATION_NAME}.sql`, "utf8")).toBe(sql);
    expect(
      readFileSync(`${root}drizzle/migrations/0052_journal_scheduled_articles.sql`, "utf8"),
    ).toBe(sql);
    expect(sql).not.toMatch(/^\s*(DROP|DELETE|UPDATE|ALTER)\s/im);
    expect(sql.match(/INSERT INTO public\.articles/g)).toHaveLength(3);
    expect(sql).toContain("'2026-10-29T08:00:00+02:00'::timestamptz");
    expect(sql).toContain("ON CONFLICT (slug) DO NOTHING");
    expect((sql.match(/\$jb\$/g) ?? []).length % 2).toBe(0);
  });

  it("a scheduled article stays hidden until its time: every public read filters on published_at", () => {
    const journal = readFileSync(`${root}src/lib/journal.ts`, "utf8");
    // the list and the single-article query both filter (the single query used to rely on the list)
    expect((journal.match(/\.lte\("published_at"/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(`${root}src/routes/sitemap[.]xml.ts`, "utf8")).toContain(
      '.lte("published_at"',
    );
  });
});
