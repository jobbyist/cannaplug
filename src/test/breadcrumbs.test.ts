import { describe, expect, it } from "vitest";
import { breadcrumbJsonLd, breadcrumbsFor, labelFromSlug } from "@/lib/breadcrumbs";

const labels = (path: string, search = "") => breadcrumbsFor(path, search).map((c) => c.label);

describe("breadcrumb trails", () => {
  it("has none on the home page or on pages that are not part of the site", () => {
    expect(breadcrumbsFor("/")).toEqual([]);
    expect(breadcrumbsFor("/offline")).toEqual([]);
    expect(breadcrumbsFor("/api/anything")).toEqual([]);
    expect(breadcrumbsFor("/billing/payfast/notify")).toEqual([]);
    expect(breadcrumbsFor("/admin/pos/receipt/abc")).toEqual([]);
  });

  it("starts at Home and ends on the current page, which is not a link", () => {
    for (const path of ["/shop", "/journal", "/about", "/rewards", "/events", "/faq", "/account"]) {
      const trail = breadcrumbsFor(path);
      expect(trail[0]).toMatchObject({ label: "Home", to: "/" });
      expect(trail.at(-1)!.to).toBeUndefined();
    }
  });

  it("the catalog shows its category or specials, with the catalog as a link back", () => {
    expect(labels("/shop")).toEqual(["Home", "Catalog"]);
    const flower = breadcrumbsFor("/shop", "?category=Flower");
    expect(flower.map((c) => c.label)).toEqual(["Home", "Catalog", "Flower"]);
    expect(flower[1]).toMatchObject({ to: "/shop" });
    expect(labels("/shop", "?sale=true")).toEqual(["Home", "Catalog", "Specials"]);
  });

  it("an article shows the Journal and a readable title from its address", () => {
    expect(labels("/journal/cannabis-etiquette-south-africa")).toEqual([
      "Home",
      "Journal",
      "Cannabis etiquette south africa",
    ]);
    expect(labelFromSlug("a_b-c")).toBe("A b c");
    expect(labelFromSlug("")).toBe("Page");
  });

  it("documents sit under the account; policies, verify and unknown pages are covered", () => {
    expect(labels("/member/documents")).toEqual(["Home", "Account", "My documents"]);
    expect(labels("/privacy-policy")).toEqual(["Home", "Privacy policy"]);
    expect(labels("/verify/abc123")).toEqual(["Home", "Verify a document"]);
    expect(labels("/some-new-page/")).toEqual(["Home", "Some new page"]);
  });

  it("builds a schema.org list for search engines (only with a real trail)", () => {
    expect(breadcrumbJsonLd([{ label: "Home", to: "/" }], "https://x.test", "/")).toBeNull();
    const ld = breadcrumbJsonLd(
      breadcrumbsFor("/journal/hello-world"),
      "https://x.test/",
      "/journal/hello-world",
    );
    expect(ld!["@type"]).toBe("BreadcrumbList");
    expect(ld!.itemListElement.map((i) => i.item)).toEqual([
      "https://x.test/",
      "https://x.test/journal",
      "https://x.test/journal/hello-world",
    ]);
    expect(ld!.itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
  });
});
