import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("styles.css baseline", () => {
  const css = readFileSync("src/styles.css", "utf8");
  it("is the full stylesheet, not a bootstrap stub", () => {
    expect(css.length).toBeGreaterThan(30_000);
  });
  it("imports journal.css before any rule", () => {
    const at = css.indexOf('@import "./journal.css";');
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(0, at)).not.toMatch(/\{/);
  });
});
