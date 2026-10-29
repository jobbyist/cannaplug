import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BUG_REPORT_INBOXES, SITE_INBOX, cleanPageAddress } from "@/lib/forms.functions";

describe("website form delivery", () => {
  it("contact form submissions go to admin@cannaplug012.co.za", () => {
    expect(SITE_INBOX).toBe("admin@cannaplug012.co.za");
  });
  it("no environment setting can redirect the inbox", () => {
    const src = readFileSync("src/lib/forms.functions.ts", "utf8");
    expect(src).not.toMatch(/CONTACT_INBOX/);
    expect(src).toMatch(/p_inbox: SITE_INBOX/);
  });

  it("bug reports go to webmaster@cannaplug012.co.za and cannaplug@gravitas.wtf, fixed in code", () => {
    expect([...BUG_REPORT_INBOXES]).toEqual([
      "webmaster@cannaplug012.co.za",
      "cannaplug@gravitas.wtf",
    ]);
    const src = readFileSync("src/lib/forms.functions.ts", "utf8");
    expect(src).toMatch(/p_inboxes: \[\.\.\.BUG_REPORT_INBOXES\]/);
    expect(src).not.toMatch(/BUG_REPORT_(INBOX|EMAIL)S?\s*=\s*process\.env/);
  });
  it("the page address sent with a report never carries a query, a fragment or a host", () => {
    expect(cleanPageAddress("/shop?category=Flower&token=secret#x")).toBe("/shop");
    expect(cleanPageAddress("https://evil.test/journal/a?x=1")).toBe("/journal/a");
    expect(cleanPageAddress(undefined)).toBeNull();
    expect(cleanPageAddress("")).toBeNull();
  });
});
