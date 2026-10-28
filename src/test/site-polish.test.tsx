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

describe("explore menu", () => {
  it("lists Our story and Rewards (New) above Gallery and Newsroom, with Promotions linking to /events", () => {
    const i = (s: string) => home.indexOf(s);
    expect(i('"Our story", "/about"')).toBeLessThan(i('"Rewards", "/rewards", "New"'));
    expect(i('"Rewards", "/rewards", "New"')).toBeLessThan(i('"Gallery", "/gallery"'));
    expect(i('"Gallery", "/gallery"')).toBeLessThan(i('"Newsroom", "/journal"'));
    expect(home).toContain('"Promotions", "/events"');
    expect(home).not.toContain('Plug Back", "/#plug-back"');
  });
  it("renames Shop products and Explore menu to Catalog and Specials", () => {
    expect(home).toContain('"Catalog", "/shop"');
    expect(home).toContain('"Specials", "/shop?sale=true"');
    expect(home).not.toContain('"Shop products", "/shop"');
    expect(home).not.toContain('"Explore menu"');
  });
  it("the gallery page is in the sitemap", () => {
    expect(STATIC_PAGES.some((p) => p.path === "/gallery")).toBe(true);
  });
});
