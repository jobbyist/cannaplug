import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  options: [
    { code: "collection", is_pickup: true, is_active: true },
    { code: "standard", is_pickup: false, is_active: true },
    { code: "discreet", is_pickup: false, is_active: true },
  ],
  rpc: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const query = () => {
    let code: string | null = null;
    type Chain = {
      select: () => Chain;
      eq: (col: string, v: unknown) => Chain;
      order: () => Promise<{ data: unknown; error: null }>;
      maybeSingle: () => Promise<{ data: unknown; error: null }>;
    };
    const chain: Chain = {
      select: () => chain,
      eq: (col: string, v: unknown) => {
        if (col === "code") code = v as string;
        return chain;
      },
      order: () => Promise.resolve({ data: db.options, error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: db.options.find((o) => o.code === code) ?? null, error: null }),
    };
    return chain;
  };
  return { supabaseAdmin: { from: query, rpc: db.rpc } };
});
vi.mock("@/lib/sale-expiry.server", () => ({ endExpiredSales: vi.fn() }));
vi.mock("@/lib/payments/payments-data.server", () => ({
  availableOnlineMethods: async () => ({ card: true, paypal: false, eft: { bank: "x" } }),
}));

import { listDeliveryOptions, placeCheckoutOrder, quoteCheckout } from "@/lib/checkout-data.server";
import { deliveryEnabled } from "@/lib/delivery-flag";

const ITEMS = [{ productId: "00000000-0000-4000-8000-000000000001", quantity: 1 }];
const order = (deliveryMethod: string) =>
  placeCheckoutOrder("00000000-0000-4000-8000-0000000000aa", {
    items: ITEMS,
    contactName: "Mia Member",
    contactPhone: "+27820000000",
    deliveryMethod,
    addressId: null,
    paymentMethod: "card",
    expectedTotal: 100,
    notes: null,
    key: "key-12345678",
  });

describe("delivery is paused: online orders are pickup only", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    db.rpc.mockReset().mockResolvedValue({ data: { total: 100 }, error: null });
  });

  it("only an exact DELIVERY_ENABLED=true switches delivery on", () => {
    expect(deliveryEnabled({})).toBe(false);
    expect(deliveryEnabled({ DELIVERY_ENABLED: "yes" })).toBe(false);
    expect(deliveryEnabled({ DELIVERY_ENABLED: " TRUE " })).toBe(true);
  });

  it("offers only the pickup option", async () => {
    expect((await listDeliveryOptions()).map((o) => o.code)).toEqual(["collection"]);
  });

  it("refuses to quote or place a delivery order, even if the browser asks for one", async () => {
    await expect(quoteCheckout("u1", ITEMS, "standard")).rejects.toThrow(/coming soon/i);
    await expect(order("discreet")).rejects.toThrow(/coming soon/i);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("still quotes and places pickup orders", async () => {
    await quoteCheckout("u1", ITEMS, "collection");
    await order("collection");
    expect(db.rpc.mock.calls.map((c) => c[0])).toEqual([
      "checkout_quote_for",
      "checkout_place_order",
    ]);
  });

  it("offers and allows delivery again once DELIVERY_ENABLED=true", async () => {
    vi.stubEnv("DELIVERY_ENABLED", "true");
    expect((await listDeliveryOptions()).length).toBe(3);
    await order("standard");
    expect(db.rpc).toHaveBeenCalledWith("checkout_place_order", expect.anything());
  });
});
