import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const accountFiles = [
  join(root, "src/routes/account.tsx"),
  ...walk(join(root, "src/components/account")),
];
const clientFiles = [
  ...walk(join(root, "src/routes")),
  ...walk(join(root, "src/components")),
].filter((f) => /\.tsx?$/.test(f));

describe("/account is wired to live state", () => {
  it("imports no mock/prototype data (only presentation images may come from fixtures)", () => {
    for (const file of accountFiles) {
      const src = readFileSync(file, "utf8");
      const fixtureImports = [...src.matchAll(/from "@\/fixtures\/([^"]+)"/g)].map((m) => m[1]);
      for (const f of fixtureImports) expect(f, file).toBe("catalog-presentation");
      expect(src, file).not.toMatch(/mock|prototype|lorem|faker|Math\.random\(/i);
    }
  });

  it("the catalog presentation fixture holds no data, only image selection", () => {
    const src = readFileSync(join(root, "src/fixtures/catalog-presentation.ts"), "utf8");
    expect(src).not.toMatch(/price|points|order_number|email/i);
  });

  it("no browser code writes a points balance (or any loyalty table)", () => {
    for (const file of clientFiles) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(
        /from\(\s*["']loyalty_(accounts|transactions|tiers|rules)["']\s*\)\s*\.\s*(insert|update|upsert|delete)/,
      );
      expect(src, file).not.toMatch(/points_balance\s*[:=]/);
    }
  });

  it("server functions never accept a user id, price, total or balance from the browser", () => {
    const src = readFileSync(join(root, "src/lib/member.functions.ts"), "utf8");
    const validators = [...src.matchAll(/\.validator\(([\s\S]*?)\)\s*\.handler/g)].map(
      (m) => m[1]!,
    );
    expect(validators.length).toBeGreaterThan(5);
    for (const v of validators) {
      expect(v).not.toMatch(/\b(userId|user_id|price|total_rand|points_balance|balance)\b/);
    }
  });

  it("checkout is wired to the server: no random order numbers, client promo or unsupported payment methods", () => {
    const src = readFileSync(join(root, "src/routes/checkout.tsx"), "utf8");
    expect(src).not.toMatch(/Math\.random|PLUGBACK|presentation prototype|SnapScan|promoDiscount/i);
    expect(src).toMatch(/placeOrderFn/);
    expect(src).toMatch(/quoteCheckoutFn/);
    // The order is created only through the server function, and the cart is cleared after it succeeds.
    expect(src.indexOf("await placeOrderFn")).toBeLessThan(src.indexOf("clear();"));
  });

  it("checkout server functions never accept a price, fee, total-to-charge or user id as authority", () => {
    const src = readFileSync(join(root, "src/lib/checkout.functions.ts"), "utf8");
    const validators = [...src.matchAll(/\.validator\(([\s\S]*?)\)\s*\.handler/g)].map(
      (m) => m[1]!,
    );
    expect(validators.length).toBe(2);
    for (const v of validators)
      expect(v).not.toMatch(/\b(userId|user_id|price|fee|unitPrice|subtotal)\b/);
  });
});
