import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PRODUCT_IMAGE_BUCKET } from "@/lib/product-media";

/** Public URL of a product photo (the bucket is public-read; uploads are server-only). */
export function productImageUrl(path: string | null | undefined): string | null {
  return path
    ? supabaseAdmin.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
    : null;
}
