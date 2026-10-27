import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/lib/notifications/templates";

const ctx = { siteUrl: "https://cannaplug012.co.za" } as never;

describe("welcome email after ID approval", () => {
  it("says the ID verification was successful and links to the shop", () => {
    const r = renderTemplate(
      "member_welcome",
      { contact_name: "Thandi Mokoena", id_verified: true },
      ctx,
    )!;
    expect(r.subject).toMatch(/ID is verified/);
    expect(r.text).toMatch(/Your ID verification was successful/);
    expect(r.html).toContain("https://cannaplug012.co.za/shop");
    expect(r.text).toMatch(/Hi Thandi/);
  });
  it("keeps the old copy for any welcome queued before this change", () => {
    const r = renderTemplate("member_welcome", { contact_name: "Thandi" }, ctx)!;
    expect(r.text).toMatch(/verify your ID once/);
  });
});
