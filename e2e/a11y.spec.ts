import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Accessibility scan of the public pages (run by scripts/a11y-e2e.sh against a production build).
// Serious and critical findings fail the run; the full report is attached to the test result.
const PAGES = ["/", "/shop", "/journal", "/account", "/faq", "/offline"];

test.describe("axe", () => {
  test.skip(!process.env["A11Y_E2E"], "run via scripts/a11y-e2e.sh");
  test.describe("the 18+ gate", () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test("/ with the gate open", async ({ page }) => {
      await page.goto("/");
      await page.getByRole("dialog", { name: "Are you 18 or older?" }).waitFor();
      const results = await new AxeBuilder({ page })
        .include('[aria-labelledby="age-gate-title"]')
        .analyze();
      const blocking = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(blocking.map((v) => v.id)).toEqual([]);
    });
  });
  for (const path of PAGES) {
    test(path, async ({ page }, info) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      await info.attach("axe.json", {
        body: JSON.stringify(results.violations, null, 2),
        contentType: "application/json",
      });
      const blocking = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map(
          (v) => `${v.id} (${v.impact}): ${v.nodes.length}× e.g. ${v.nodes[0]?.target.join(" ")}`,
        );
      expect(blocking, blocking.join("\n")).toEqual([]);
    });
  }
});
