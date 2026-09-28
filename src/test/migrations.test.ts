import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const canonical = join(root, "supabase/migrations");
const legacy = join(root, "drizzle/migrations");

const sqlFiles = (dir: string) => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    throw new Error(
      `Failed to read migration directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

describe("supabase migrations", () => {
  it("use timestamped names", () => {
    for (const f of sqlFiles(canonical)) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it("match the legacy drizzle mirror byte-for-byte, in order", () => {
    const a = sqlFiles(canonical);
    const b = sqlFiles(legacy);
    expect(a).toHaveLength(b.length);
    a.forEach((f, i) => {
      expect(readFileSync(join(canonical, f), "utf8")).toBe(
        readFileSync(join(legacy, b[i]!), "utf8"),
      );
    });
  });
});
