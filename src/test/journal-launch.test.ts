import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTHOR_NAME, LAUNCH_ARTICLES } from "@/lib/journal-launch-articles";
import { complianceViolations } from "@/lib/newsroom/pipeline";
import { buildJournalMigration, MIGRATION_NAME } from "../../scripts/journal-migration";

const root = new URL("../../", import.meta.url).pathname;

describe("launch articles", () => {
  it("are four, by Dithekgo M., published 25, 26, 27 and 28 October 2026", () => {
    expect(AUTHOR_NAME).toBe("Dithekgo M.");
    expect(LAUNCH_ARTICLES).toHaveLength(4);
    expect(LAUNCH_ARTICLES.map((a) => a.published_at.slice(0, 10))).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
    ]);
    expect(new Set(LAUNCH_ARTICLES.map((a) => a.slug)).size).toBe(4);
  });

  it.each(LAUNCH_ARTICLES.map((a) => [a.slug, a] as const))(
    "%s passes the compliance gate and has a proper heading hierarchy",
    (_slug, a) => {
      expect(complianceViolations(a)).toEqual([]);
      // The page renders the title as the only H1: the body has none, and starts with an H2.
      expect(a.body_md).not.toMatch(/^# /m);
      expect(a.body_md.trimStart().startsWith("## ")).toBe(true);
      const h2 = a.body_md.match(/^## .+$/gm) ?? [];
      expect(h2.length).toBeGreaterThanOrEqual(5);
      expect(a.body_md).toMatch(/^### .+$/m);
      expect(h2.at(-1)!.toLowerCase()).toContain("takeaway");
      // SEO basics
      expect(a.title.length).toBeLessThanOrEqual(70);
      expect(a.excerpt.length).toBeGreaterThanOrEqual(100);
      expect(a.excerpt.length).toBeLessThanOrEqual(200);
      expect(a.keywords.length).toBeGreaterThanOrEqual(5);
      expect(a.body_md.split(/\s+/).length).toBeGreaterThan(300);
      // images: one cover and two inline photos after real sections
      const cover = a.image_queries.filter((q) => q.role === "cover");
      const inline = a.image_queries.filter((q) => q.role === "inline");
      expect(cover).toHaveLength(1);
      expect(inline).toHaveLength(2);
      for (const q of a.image_queries) expect(q.alt.length).toBeGreaterThan(10);
      for (const q of inline) expect(q.after_section).toBeLessThan(h2.length);
      // 1-3 seeded comments, none of them medical claims or contact details
      expect(a.comments.length).toBeGreaterThanOrEqual(1);
      expect(a.comments.length).toBeLessThanOrEqual(3);
      for (const c of a.comments) {
        expect(complianceViolations({ title: "", excerpt: "", body_md: c.body })).toEqual([]);
        expect(c.body).not.toMatch(/@|https?:|\d{9,}/);
      }
    },
  );

  it("the law article cites the Constitutional Court judgment", () => {
    const law = LAUNCH_ARTICLES[0]!;
    expect(law.sources.map((s) => new URL(s.url).hostname)).toEqual(
      expect.arrayContaining(["www.concourt.org.za"]),
    );
    expect(law.body_md).toContain("18 September 2018");
    expect(law.body_md.toLowerCase()).toContain("not legal advice");
  });
});

describe("the journal migration", () => {
  it("is exactly what scripts/journal-migration.ts generates, mirrored in drizzle", () => {
    const sql = buildJournalMigration();
    expect(readFileSync(`${root}supabase/migrations/${MIGRATION_NAME}.sql`, "utf8")).toBe(sql);
    expect(readFileSync(`${root}drizzle/migrations/0048_journal_engagement.sql`, "utf8")).toBe(sql);
  });

  it("has RLS on both tables, no browser grants, service-role-only functions, and no DROP or DELETE statements", () => {
    const sql = buildJournalMigration();
    expect(sql).toMatch(/ALTER TABLE public\.article_likes ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE public\.article_comments ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /REVOKE ALL ON public\.article_likes, public\.article_comments FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).not.toMatch(/\bGRANT\b[^;]*\bTO\s+(anon|authenticated)\b/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION %s TO service_role/);
    expect(sql).not.toMatch(/^\s*DROP\s/im);
    expect(sql).not.toMatch(/^\s*DELETE\s+FROM/im);
    expect((sql.match(/\$\$/g) ?? []).length % 2).toBe(0);
  });
});
