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
  it("the homepage section is 'Events & Promotions' and links to /events", () => {
    expect(home).toContain('title="EVENTS & PROMOTIONS"');
    expect(home).toMatch(/action="View all"\s+href="\/events"/);
  });
  it("event cards have no RSVP / View event links", () => {
    expect(home).not.toMatch(/RSVP/);
  });
  it("the events page is in the sitemap", () => {
    expect(STATIC_PAGES.some((p) => p.path === "/events")).toBe(true);
  });
});
