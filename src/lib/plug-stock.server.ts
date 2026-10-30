/**
 * The one stock reader Ask The Plug uses, for the quiz and the AI chat alike: plug_match_candidates applies the hard
 * filters in the database at the moment of the call (active, sold online, live availability at or above the safety
 * buffer, which is higher for fast sellers; no practitioner recommendation needed). No cache, by design.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Candidate } from "@/lib/plug-match";
import { productImageUrl } from "@/lib/product-image-url.server";

type Row = {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  strain_type: string | null;
  price_rand: number | string;
  regular_price_rand: number | string | null;
  unit: string | null;
  image_path: string | null;
  is_featured: boolean;
  sort_order: number;
  available: number;
};

/** In-stock candidates at this moment (hard filters + safety buffer in the database). */
export async function liveCandidates(categories: string[] | null = null): Promise<Candidate[]> {
  const { data, error } = await supabaseAdmin.rpc("plug_match_candidates", {
    p_categories: categories,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    subcategory: r.subcategory,
    strainType: r.strain_type,
    price: Number(r.price_rand),
    regularPrice: r.regular_price_rand == null ? null : Number(r.regular_price_rand),
    unit: r.unit,
    imageUrl: productImageUrl(r.image_path),
    isFeatured: r.is_featured,
    sortOrder: r.sort_order,
    available: Number(r.available),
  }));
}

/** Names of active products that are NOT offered right now (sold out, below the buffer, or not sold online). */
export async function unavailableNames(offered: Candidate[]): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("products")
    .select("name")
    .eq("is_active", true)
    .limit(2000);
  if (error) throw new Error(error.message);
  const ok = new Set(offered.map((c) => c.name.trim().toLowerCase()));
  return [...new Set((data ?? []).map((r) => (r as { name: string }).name.trim()))].filter(
    (n) => !ok.has(n.toLowerCase()),
  );
}
