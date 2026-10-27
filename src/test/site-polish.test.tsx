import { describe, expect, it } from "vitest";
import { STATIC_PAGES } from "@/lib/site";
import { readFileSync } from "node:fs";

const home = readFileSync("src/components/CannaPlugHome.tsx", "utf8");

describe("site polish", () => {
  it("the footer announces both app stores as coming soon", () => {
    expect(home).toContain("Coming soon to the");
    expect(home).toContain("App Store");
    expect(home).toContain("Coming soon to");
    expect(home).toContain("Google Play");
  });
  it("the events 'View calendar' link goes to /calendar", () => {
    expect(home).toMatch(/action="View calendar"\s+href="\/calendar"/);
  });
  it("the calendar page is in the sitemap", () => {
    expect(STATIC_PAGES.some((p) => p.path === "/calendar")).toBe(true);
  });
});
