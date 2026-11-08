/**
 * Custom till items (8 Nov 2026). Every sale line needs a product id, so custom lines point at one hidden placeholder
 * product created by migration 20261108002000_pos_custom_items. It is never shown in a product list, the shop or the
 * till search, and is never edited, imported or exported. Keep in sync with public.pos_custom_item_product_id().
 */
export const CUSTOM_ITEM_PRODUCT_ID = "00000000-0000-4000-8000-00000000c057";
