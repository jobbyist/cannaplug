import categoryImage from "@/assets/cannaplug-categories.jpg";
import productImage from "@/assets/cannaplug-products.jpg";

export function getCatalogImage(category: string) {
  return category === "Accessories" ? categoryImage : productImage;
}
