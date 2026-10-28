import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCH_ARTICLES, PUBLISHED_AUTHOR_NAME } from "@/lib/journal-launch-articles";
import { SCHEDULED_ARTICLES } from "@/lib/journal-scheduled-articles";
import { DB_URL, connect, type Sql } from "./helpers";

// Other database tests add their own articles, so only the seven journal articles are looked at.
const SLUGS = [...LAUNCH_ARTICLES, ...SCHEDULED_ARTICLES].map((a) => a.slug);

describe.skipIf(!DB_URL)("journal byline (real PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(() => {
    sql = connect(4);
  });
  afterAll(async () => {
    await sql.end();
  });

  it("all seven launch and scheduled articles are published as Michael C.", async () => {
    expect(SLUGS).toHaveLength(7);
    const rows =
      await sql`SELECT author_name, count(*)::int AS n FROM public.articles WHERE slug IN ${sql(SLUGS)} GROUP BY 1`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ author_name: PUBLISHED_AUTHOR_NAME, n: 7 }]);
    expect(PUBLISHED_AUTHOR_NAME).toBe("Michael C.");
  });

  it("only the byline changed: the dates are still 25 to 28 October, then 8 AM SAST on 29, 30 and 31 October", async () => {
    const rows =
      await sql`SELECT (published_at AT TIME ZONE 'Africa/Johannesburg')::text AS at FROM public.articles WHERE slug IN ${sql(SLUGS)} ORDER BY published_at`;
    expect(rows.map((r) => String(r["at"]).slice(0, 10))).toEqual([
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
    ]);
    expect(String(rows.at(-1)!["at"])).toMatch(/ 08:00:00/);
  });
});
