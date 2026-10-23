import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertRole } from "@/lib/admin-data.server";
import { sniffMime } from "@/lib/verification-logic";
import { productImageUrl } from "@/lib/product-image-url.server";
import {
  PRODUCT_IMAGE_BUCKET,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_MIME_TO_EXT,
  isProductImagePath,
} from "@/lib/product-media";

const bucket = () => supabaseAdmin.storage.from(PRODUCT_IMAGE_BUCKET);

/** Manager+: a one-time signed upload URL for a new photo of an existing product. */
export async function createProductImageUpload(userId: string, productId: string, mime: string) {
  await assertRole(userId, "manager");
  const ext = PRODUCT_IMAGE_MIME_TO_EXT[mime];
  if (!ext) throw new Error("Upload a JPG, PNG or WebP photo.");
  const { data: product } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("id", productId)
    .maybeSingle();
  if (!product) throw new Error("Product not found.");
  const path = `products/${productId}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await bucket().createSignedUploadUrl(path);
  if (error || !data) throw new Error("We couldn't start the upload. Please try again.");
  return { path, token: data.token };
}

/** Manager+: checks what was actually stored (size + magic bytes), then points the product at it. */
export async function attachProductImage(userId: string, productId: string, path: string) {
  await assertRole(userId, "manager");
  if (!isProductImagePath(productId, path)) throw new Error("Invalid image path.");
  const { data: file, error } = await bucket().download(path);
  if (error || !file) throw new Error("We couldn't find the uploaded photo — please try again.");
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const detected = sniffMime(head);
  const ext = path.split(".").pop();
  if (
    file.size > PRODUCT_IMAGE_MAX_BYTES ||
    !detected ||
    PRODUCT_IMAGE_MIME_TO_EXT[detected] !== ext
  ) {
    await bucket().remove([path]);
    throw new Error("That file isn't a JPG, PNG or WebP photo under 2 MB.");
  }
  const { data: before } = await supabaseAdmin
    .from("products")
    .select("image_path")
    .eq("id", productId)
    .single();
  const { error: upd } = await supabaseAdmin
    .from("products")
    .update({ image_path: path })
    .eq("id", productId);
  if (upd) throw upd;
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "product_image_updated",
    entity_type: "product",
    entity_id: productId,
    metadata: { replaced: Boolean(before?.image_path) },
  });
  if (before?.image_path && before.image_path !== path) await bucket().remove([before.image_path]);
  return { imageUrl: productImageUrl(path) };
}

/** Manager+: removes the photo; the shop falls back to the category picture. */
export async function removeProductImage(userId: string, productId: string) {
  await assertRole(userId, "manager");
  const { data: before } = await supabaseAdmin
    .from("products")
    .select("image_path")
    .eq("id", productId)
    .single();
  if (!before?.image_path) return { removed: false };
  const { error } = await supabaseAdmin
    .from("products")
    .update({ image_path: null })
    .eq("id", productId);
  if (error) throw error;
  await bucket().remove([before.image_path]);
  await supabaseAdmin.from("audit_log").insert({
    actor_user_id: userId,
    action: "product_image_removed",
    entity_type: "product",
    entity_id: productId,
  });
  return { removed: true };
}
