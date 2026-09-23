// Presentation-ready mock data shaped to match the Supabase `products` / `orders` /
// `order_items` / `profiles` tables (see src/integrations/supabase/types.ts) so the
// shop, checkout, member portal and admin dashboard can be swapped to live Supabase
// queries later without changing field names.

export type Product = {
  id: string;
  slug: string;
  name: string;
  category: "Flower" | "Edibles" | "Vapes" | "Concentrates" | "Accessories";
  subcategory: string | null;
  strain_type: "Indica" | "Sativa" | "Hybrid" | null;
  price_rand: number;
  unit: string | null;
  badge: string | null;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  image: string;
};

export type MockOrderItem = {
  product_name: string;
  quantity: number;
  unit_price_rand: number;
};

export type MockOrder = {
  id: string;
  order_number: string;
  status: "Processing" | "Confirmed" | "Shipped" | "In Transit" | "Delivered" | "Cancelled";
  total_rand: number;
  created_at: string;
  contact_name: string | null;
  items: MockOrderItem[];
};

export type MockProfile = {
  full_name: string;
  phone: string | null;
  address: string | null;
  rewardsPoints: number;
  rewardsToNextTier: number;
  memberSince: string;
};

import categoryImage from "@/assets/cannaplug-categories.jpg";
import productImage from "@/assets/cannaplug-products.jpg";

export const products: Product[] = [
  { id: "p1", slug: "gelato-33", name: "Gelato 33", category: "Flower", subcategory: "Premium Flower", strain_type: "Hybrid", price_rand: 350, unit: "3.5g", badge: "Premium", description: "A dessert-leaning hybrid with sweet citrus notes and a relaxed, euphoric finish.", is_active: true, sort_order: 1, image: productImage },
  { id: "p2", slug: "blue-mix", name: "Blue Mix", category: "Flower", subcategory: "Premium Flower", strain_type: "Indica", price_rand: 420, unit: "3.5g", badge: "Best seller", description: "Deep berry aroma with a slow, grounding body effect. A house favourite.", is_active: true, sort_order: 2, image: productImage },
  { id: "p3", slug: "sativa-sunrise", name: "Sativa Sunrise", category: "Flower", subcategory: "Premium Flower", strain_type: "Sativa", price_rand: 380, unit: "3.5g", badge: null, description: "Bright, uplifting and energising — a clean daytime strain.", is_active: true, sort_order: 3, image: productImage },
  { id: "p4", slug: "mixed-flavour-gummies", name: "Mixed Flavour Gummies", category: "Edibles", subcategory: "10 pack", strain_type: "Hybrid", price_rand: 300, unit: "10 pack", badge: "Popular", description: "10mg per gummy, lab-dosed for consistency. Assorted fruit flavours.", is_active: true, sort_order: 4, image: productImage },
  { id: "p5", slug: "dark-chocolate-bar", name: "Dark Chocolate Bar", category: "Edibles", subcategory: "Infused chocolate", strain_type: null, price_rand: 260, unit: "8 squares", badge: null, description: "70% dark chocolate, evenly dosed and easy to microdose.", is_active: true, sort_order: 5, image: productImage },
  { id: "p6", slug: "raw-distillate-cart", name: "Raw Distillate Cart", category: "Vapes", subcategory: "1g cartridge", strain_type: "Sativa", price_rand: 420, unit: "1g", badge: "Lab tested", description: "Clean, potent distillate in a standard 510-thread cartridge.", is_active: true, sort_order: 6, image: productImage },
  { id: "p7", slug: "live-resin-cart", name: "Live Resin Cart", category: "Vapes", subcategory: "1g cartridge", strain_type: "Hybrid", price_rand: 480, unit: "1g", badge: "New", description: "Full-spectrum live resin for a richer flavour and effect profile.", is_active: true, sort_order: 7, image: productImage },
  { id: "p8", slug: "gold-shatter", name: "Gold Shatter", category: "Concentrates", subcategory: "Shatter", strain_type: "Indica", price_rand: 450, unit: "1g", badge: null, description: "High-purity shatter with a smooth, glassy break.", is_active: true, sort_order: 8, image: productImage },
  { id: "p9", slug: "indoor-pre-rolls", name: "Indoor Pre-Rolls", category: "Flower", subcategory: "Pre-rolls", strain_type: "Hybrid", price_rand: 500, unit: "5 pack", badge: null, description: "Five ready-to-go indoor-grown pre-rolls in a reusable CannaPlug tube.", is_active: true, sort_order: 9, image: productImage },
  { id: "p10", slug: "cannaplug-grinder", name: "CannaPlug Grinder", category: "Accessories", subcategory: "Tools", strain_type: null, price_rand: 250, unit: "1 unit", badge: "New", description: "4-piece aircraft-grade aluminium grinder with pollen catcher.", is_active: true, sort_order: 10, image: categoryImage },
  { id: "p11", slug: "glass-rolling-tray", name: "Glass Rolling Tray", category: "Accessories", subcategory: "Tools", strain_type: null, price_rand: 180, unit: "1 unit", badge: null, description: "Tempered glass tray with raised edges for a tidy roll.", is_active: true, sort_order: 11, image: categoryImage },
  { id: "p12", slug: "terpene-drops", name: "Terpene Drops", category: "Concentrates", subcategory: "Terpenes", strain_type: null, price_rand: 220, unit: "5ml", badge: null, description: "Food-grade terpene blend for flavour and aroma layering.", is_active: true, sort_order: 12, image: productImage },
];

export const categories = ["All", "Flower", "Edibles", "Vapes", "Concentrates", "Accessories"] as const;

export const mockProfile: MockProfile = {
  full_name: "Michael Barck",
  phone: "+27 82 555 0134",
  address: "12 Jasmine Street, Waterkloof, Pretoria",
  rewardsPoints: 320,
  rewardsToNextTier: 180,
  memberSince: "2023-04-11",
};

export const mockOrders: MockOrder[] = [
  {
    id: "o1", order_number: "RCP-10423", status: "Delivered", total_rand: 1020, created_at: "2026-04-19T10:00:00Z", contact_name: "Michael Barck",
    items: [{ product_name: "Gelato 33", quantity: 2, unit_price_rand: 350 }, { product_name: "Anti-Odour Jar", quantity: 1, unit_price_rand: 320 }],
  },
  {
    id: "o2", order_number: "RCR-10421", status: "Delivered", total_rand: 640, created_at: "2026-04-04T10:00:00Z", contact_name: "Michael Barck",
    items: [{ product_name: "Mixed Flavour Gummies", quantity: 2, unit_price_rand: 300 }],
  },
  {
    id: "o3", order_number: "RC2-10412", status: "In Transit", total_rand: 400, created_at: "2026-04-19T10:00:00Z", contact_name: "Michael Barck",
    items: [{ product_name: "Blue Mix Flower", quantity: 1, unit_price_rand: 420 }],
  },
];

export const adminOrders: { orderId: string; customer: string; total: number; status: MockOrder["status"]; date: string }[] = [
  { orderId: "07-10172", customer: "J. Dreyfus", total: 820, status: "Confirmed", date: "12 Apr" },
  { orderId: "09-10119", customer: "T. Raxtomer", total: 920, status: "Delivered", date: "12 Apr" },
  { orderId: "09-10379", customer: "L. van der Hoven", total: 900, status: "Processing", date: "14 Apr" },
  { orderId: "09-10329", customer: "S. Total", total: 520, status: "Confirmed", date: "10 Apr" },
  { orderId: "02-10429", customer: "S. Hgwater", total: 880, status: "Delivered", date: "10 Apr" },
];

export const adminStats = {
  totalOrders: 1248,
  revenueRand: 182450,
  inventoryAlerts: 5,
  totalCustomers: 3892,
};

export const salesOverview = [
  { day: "Mon", value: 210000 },
  { day: "Tue", value: 260000 },
  { day: "Wed", value: 280000 },
  { day: "Thu", value: 300000 },
  { day: "Fri", value: 340000 },
  { day: "Sat", value: 460000 },
  { day: "Sun", value: 390000 },
];

export const inventoryStatus = [
  { name: "Gelato 33", percent: 18 },
  { name: "Blue Mix", percent: 18 },
  { name: "Sapphire OG", percent: 52 },
  { name: "Concentrates", percent: 91 },
  { name: "Accessories", percent: 91 },
];

export const lowStockAlerts = [
  "Blue Mix Flower — 1 unit left",
  "Live Resin Cart — 3 units left",
  "Mixed Chocolate Bar — 1 unit left",
  "Indoor Pre-Rolls (Small) — 2 units left",
  "Gold Shatter — 4 units left",
];

export const topProducts = [
  { name: "Gelato 33", sold: 342 },
  { name: "Blue Mix", sold: 316 },
  { name: "Mixed Flavour Gummies", sold: 211 },
  { name: "Live Resin Cart", sold: 205 },
  { name: "CannaPlug Grinder", sold: 119 },
];

export const recentActivity = [
  { label: "New order ACF-0002", time: "11 Apr · 19:04" },
  { label: "Restocked Gelato 33", time: "10 Apr · 16:32" },
  { label: "Loyalty points redeemed", time: "11 Apr · 18:35" },
  { label: "New customer registered", time: "11 Apr · 18:32" },
];
