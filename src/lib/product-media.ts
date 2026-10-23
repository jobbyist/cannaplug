// Product photos: pure rules shared by the browser (pre-checks, resizing) and the server (authoritative checks).
export const PRODUCT_IMAGE_BUCKET = "product-images";
export const PRODUCT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_EDGE = 1200;
export const PRODUCT_IMAGE_MIME_TO_EXT: Record<string, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
export const PRODUCT_IMAGE_ACCEPT = Object.keys(PRODUCT_IMAGE_MIME_TO_EXT).join(",");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The only path shape the server mints: products/<productId>/<uuid>.<jpg|png|webp> (the DB CHECK repeats it). */
export function isProductImagePath(productId: string, path: string): boolean {
  if (!new RegExp(`^${UUID}$`, "i").test(productId)) return false;
  return new RegExp(`^products/${productId}/${UUID}\\.(jpg|png|webp)$`, "i").test(path);
}

export function checkProductImageFile(file: { size: number; type: string }): string | null {
  if (!PRODUCT_IMAGE_MIME_TO_EXT[file.type]) return "Upload a JPG, PNG or WebP photo.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) return "That photo is over 2 MB after resizing.";
  return null;
}

/** Fits an image inside a square of `max` pixels, never enlarging it. */
export function fitWithin(width: number, height: number, max = PRODUCT_IMAGE_MAX_EDGE) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Normalises staff-typed SKU/barcode values: trims, empties become null. */
export const cleanCode = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t ? t : null;
};
