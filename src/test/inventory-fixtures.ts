import type { InventoryRow } from "@/lib/inventory-logic";

/** An inventory row with sensible defaults for tests. */
export const row = (o: Partial<InventoryRow>): InventoryRow => ({
  product_id: o.name ?? "p",
  name: "Product",
  sku: null,
  category: "Flower",
  brand: null,
  unit: null,
  sold_by_weight: false,
  is_active: true,
  sell_online: true,
  track_stock: true,
  low_stock_threshold: 5,
  price_rand: 100,
  regular_price_rand: null,
  image_url: null,
  on_hand: 10,
  held: 0,
  available: 10,
  expired: 0,
  batches: 1,
  next_expiry: null,
  stock_value: null,
  ...o,
});
