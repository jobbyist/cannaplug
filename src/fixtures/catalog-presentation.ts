import categoryImage from "@/assets/cannaplug-categories.jpg";
import productImage from "@/assets/cannaplug-products.jpg";

export const categoryOptions = ["All", "Flower", "Edibles", "Vapes", "Concentrates", "Accessories"] as const;

export function getCatalogImage(category: string) {
  return category === "Accessories" ? categoryImage : productImage;
}
