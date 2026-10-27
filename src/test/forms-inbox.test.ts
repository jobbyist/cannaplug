import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SITE_INBOX } from "@/lib/forms.functions";

describe("website form delivery", () => {
  it("contact form submissions go to admin@cannaplug012.co.za", () => {
    expect(SITE_INBOX).toBe("admin@cannaplug012.co.za");
  });
  it("no environment setting can redirect the inbox", () => {
    const src = readFileSync("src/lib/forms.functions.ts", "utf8");
    expect(src).not.toMatch(/CONTACT_INBOX/);
    expect(src).toMatch(/p_inbox: SITE_INBOX/);
  });
});
