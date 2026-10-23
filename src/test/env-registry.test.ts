import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_VARS } from "../../scripts/env-registry";
import { markdown, missing, parseDotenv } from "../../scripts/check-env";

const root = new URL("../../", import.meta.url).pathname;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });

describe("environment registry", () => {
  it("lists every variable the app reads", () => {
    const used = new Set<string>();
    for (const f of walk(join(root, "src"))) {
      if (f.includes("/test/")) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(
        /(?:process\.env|import\.meta\.env|\benv)(?:\.|\[["'])([A-Z][A-Z0-9_]+)/g,
      ))
        used.add(m[1]!);
    }
    const known = new Set(ENV_VARS.map((v) => v.name));
    const unknown = [...used].filter(
      (n) => !known.has(n) && !["NODE_ENV", "DEV", "PROD", "MODE", "SSR"].includes(n),
    );
    expect(unknown).toEqual([]);
  });
  it("has no duplicates", () => {
    const names = ENV_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it("parses .env files and reports gaps, ignoring retiring and test-only variables", () => {
    const env = parseDotenv(
      `# c\nSUPABASE_URL="https://x"\nexport SITE_URL='https://y'\nBAD LINE\n`,
    );
    expect(env).toEqual({ SUPABASE_URL: "https://x", SITE_URL: "https://y" });
    const gaps = missing(env).map((g) => g.name);
    expect(gaps).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(gaps).not.toContain("SUPABASE_URL");
    expect(gaps).not.toContain("YOCO_SECRET_KEY");
    expect(gaps).not.toContain("TEST_DATABASE_URL");
  });
  it("matches the committed env matrix", () => {
    const norm = (t: string) =>
      t
        .split("\n")
        .map((l) =>
          l
            .replace(/\s*\|\s*/g, "|")
            .replace(/\|-+(?=\|)/g, "|-")
            .trim(),
        )
        .filter(Boolean)
        .join("\n");
    expect(norm(readFileSync(join(root, "docs/release/env-matrix.md"), "utf8"))).toBe(
      norm(markdown()),
    );
  });
});
