import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkProductImageFile,
  cleanCode,
  fitWithin,
  isProductImagePath,
} from "@/lib/product-media";

const db = vi.hoisted(() => ({ role: "manager", products: [] as Record<string, unknown>[] }));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "in"]) q[m] = () => q;
    q["then"] = (res: (v: unknown) => unknown) => res({ data: rows(), error: null });
    return q;
  };
  return {
    supabaseAdmin: {
      from: (table: string) =>
        chain(() => (table === "user_roles" ? [{ role: db.role }] : db.products)),
      storage: {
        from: () => ({
          getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }),
        }),
      },
    },
  };
});

const pid = "11111111-2222-4333-8444-555555555555";
const img = "66666666-7777-4888-9999-000000000000";

describe("product photo rules", () => {
  it("accepts only the server-minted path shape for that product", () => {
    expect(isProductImagePath(pid, `products/${pid}/${img}.webp`)).toBe(true);
    expect(isProductImagePath(pid, `products/${img}/${img}.webp`)).toBe(false);
    expect(isProductImagePath(pid, `products/${pid}/../${img}.webp`)).toBe(false);
    expect(isProductImagePath(pid, `products/${pid}/${img}.svg`)).toBe(false);
    expect(isProductImagePath("not-a-uuid", `products/not-a-uuid/${img}.jpg`)).toBe(false);
  });
  it("pre-checks type and size", () => {
    expect(checkProductImageFile({ size: 1000, type: "image/webp" })).toBeNull();
    expect(checkProductImageFile({ size: 1000, type: "image/svg+xml" })).toMatch(
      /JPG, PNG or WebP/,
    );
    expect(checkProductImageFile({ size: 0, type: "image/png" })).toMatch(/empty/);
    expect(checkProductImageFile({ size: 3 * 1024 * 1024, type: "image/png" })).toMatch(/2 MB/);
  });
  it("fits within 1200 px without enlarging", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1200, height: 900 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 10)).toEqual({ width: 0, height: 0 });
  });
  it("cleans SKU and barcode input", () => {
    expect(cleanCode("  SKU-1 ")).toBe("SKU-1");
    expect(cleanCode("   ")).toBeNull();
    expect(cleanCode(null)).toBeNull();
  });
});

describe("listAdminProducts cost privacy", () => {
  beforeEach(() => {
    db.products = [
      { id: pid, name: "Gelato", cost_rand: 21, image_path: `products/${pid}/${img}.webp` },
    ];
  });
  it("hides cost from budtenders and shows it to managers, with image URLs", async () => {
    const { listAdminProducts } = await import("@/lib/admin-data.server");
    db.role = "budtender";
    const asBudtender = await listAdminProducts("u1");
    expect(asBudtender[0]!.cost_rand).toBeNull();
    expect(asBudtender[0]!.image_url).toBe(`https://cdn.test/products/${pid}/${img}.webp`);
    db.role = "manager";
    expect((await listAdminProducts("u1"))[0]!.cost_rand).toBe(21);
  });
});
