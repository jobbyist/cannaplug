import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * A signed-in member's saved basket. The browser sends product ids and quantities only; names and prices
 * are always read live, so a saved basket can never carry a stale price. The database function does the
 * validation again (at most 50 lines, quantity 1 to 999). The member id comes from the verified token.
 */
const line = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(999),
});

export type SavedCartLine = {
  productId: string;
  name: string;
  price: number;
  unit: string | null;
  quantity: number;
};

export const saveCartFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((d) => z.object({ items: z.array(line).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("cart_save", {
      p_user_id: context.userId,
      p_items: data.items.map((i) => ({ product_id: i.productId, quantity: i.quantity })),
    });
    if (error) throw new Error("Could not save your basket.");
    return { ok: true as const };
  });

export const getCartFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SavedCartLine[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: saved, error } = await supabaseAdmin.rpc("cart_get", {
      p_user_id: context.userId,
    });
    if (error) throw new Error("Could not load your basket.");
    const items = (Array.isArray(saved) ? saved : []) as { product_id: string; quantity: number }[];
    if (items.length === 0) return [];
    const { data: products } = await supabaseAdmin
      .from("products")
      .select("id, name, price_rand, unit")
      .in(
        "id",
        items.map((i) => i.product_id),
      )
      .eq("is_active", true);
    const byId = new Map((products ?? []).map((p) => [p.id, p]));
    return items.flatMap((i) => {
      const p = byId.get(i.product_id);
      return p
        ? [
            {
              productId: p.id,
              name: p.name,
              price: Number(p.price_rand),
              unit: p.unit ?? null,
              quantity: i.quantity,
            },
          ]
        : [];
    });
  });

export const unsubscribeCartFn = createServerFn({ method: "POST" })
  .validator((d) => z.object({ token: z.string().regex(/^[0-9a-f]{48}$/) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("cart_unsubscribe", { p_token: data.token });
    if (error) throw new Error("That link did not work.");
    return { ok: true as const };
  });
