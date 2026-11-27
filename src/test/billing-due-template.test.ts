import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/lib/notifications/templates";

const ctx = { siteUrl: "https://cannaplug012.co.za" };
const data = {
  account: "Online Payment Gateway Aggregator",
  provider: "Payfast",
  amount_text: "R180.00",
  due_on: "Friday, 27 November 2026",
  next_account: "Admin/Checkout API Integration (POS + E-Commerce)",
  next_provider: "Shopify",
  next_amount_text: "$28.75 incl. 15% sales tax ($25.00 excl.), approx. R470.00",
  next_due_on: "Sunday, 29 November 2026",
};

describe("staff_billing_due email", () => {
  it("says tomorrow by default and today when due_in_days is 0", () => {
    const tomorrow = renderTemplate("staff_billing_due", data, ctx)!;
    expect(tomorrow.subject).toBe("Bill due tomorrow: Online Payment Gateway Aggregator");
    expect(tomorrow.html).toContain("Bill due tomorrow");
    const today = renderTemplate("staff_billing_due", { ...data, due_in_days: 0 }, ctx)!;
    expect(today.subject).toBe("Bill due today: Online Payment Gateway Aggregator");
    expect(today.html).toContain("falls due today");
  });

  it("shows the bill, the next bill and the webmaster line, in HTML and plain text", () => {
    const r = renderTemplate("staff_billing_due", data, ctx)!;
    for (const part of [
      "Payfast",
      "R180.00",
      "Friday, 27 November 2026",
      "Next bill after this one",
      "Shopify",
      "Sunday, 29 November 2026",
    ]) {
      expect(r.html).toContain(part);
      expect(r.text).toContain(part);
    }
    expect(r.text).toContain(
      "Contact the webmaster at webmaster@cannaplug012.co.za to avoid any disruption to your service.",
    );
    expect(r.html).toContain('href="mailto:webmaster@cannaplug012.co.za"');
    expect(r.html).toContain("https://cannaplug012.co.za/admin#billing");
  });

  it("leaves out the next-bill block and the amount row when they are not known, and escapes text", () => {
    const r = renderTemplate(
      "staff_billing_due",
      { account: "<b>X</b>", provider: "P", due_on: "Friday, 27 November 2026" },
      ctx,
    )!;
    expect(r.html).not.toContain("Next bill after this one");
    expect(r.html).not.toContain(">Amount<");
    expect(r.html).not.toContain("<b>X</b>");
    expect(r.html).toContain("&lt;b&gt;X&lt;/b&gt;");
  });
});
