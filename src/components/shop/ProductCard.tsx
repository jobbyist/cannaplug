import { useState } from "react";
import { Check, ShoppingBag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCart, rand } from "@/lib/cart";
import { getCatalogImage } from "@/fixtures/catalog-presentation";
import type { listStoreProductsFn } from "@/lib/admin.functions";

export type StoreProduct = Awaited<ReturnType<typeof listStoreProductsFn>>[number];

export function ProductCard({ product }: { product: StoreProduct }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  const image = product.image_url ?? getCatalogImage(product.category);

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition hover:-translate-y-1 hover:shadow-lg">
      <div className="relative h-48 overflow-hidden bg-secondary">
        {!product.in_stock && (
          <span className="absolute left-3 top-3 z-10 rounded-full bg-background/95 px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-wide text-muted-foreground">
            Out of stock
          </span>
        )}
        {product.badge && (
          <span className="absolute right-3 top-3 z-10 rounded-full bg-primary px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-wide text-primary-foreground">
            {product.badge}
          </span>
        )}
        <img
          src={image}
          alt={product.name}
          width={400}
          height={300}
          loading="lazy"
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
        />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{product.subcategory ?? product.category}</span>
          {product.strain_type && <Badge variant="outline">{product.strain_type}</Badge>}
        </div>
        <h3 className="font-display text-sm font-bold uppercase">{product.name}</h3>
        <p className="line-clamp-2 flex-1 text-xs leading-relaxed text-muted-foreground">
          {product.description}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div>
            {product.regular_price_rand != null && (
              <s className="mr-1 text-[0.7rem] text-muted-foreground">
                {rand(product.regular_price_rand)}
              </s>
            )}
            <b className="text-sm">{rand(product.price_rand)}</b>
            {product.unit && (
              <span className="ml-1 text-[0.65rem] text-muted-foreground">/ {product.unit}</span>
            )}
          </div>
          <Button
            size="sm"
            onClick={() => {
              add({
                productId: product.id,
                name: product.name,
                price: product.price_rand,
                unit: product.unit,
              });
              setAdded(true);
              window.setTimeout(() => setAdded(false), 1400);
            }}
          >
            {added ? (
              <>
                <Check size={14} /> Added
              </>
            ) : (
              <>
                Add <ShoppingBag size={14} />
              </>
            )}
          </Button>
        </div>
      </div>
    </article>
  );
}
