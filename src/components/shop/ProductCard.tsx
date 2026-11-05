import { useState } from "react";
import { Check, ShoppingBag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCart, rand } from "@/lib/cart";
import { saleStep, batchNote } from "@/lib/sale-step";
import { getCatalogImage } from "@/fixtures/catalog-presentation";
import type { listStoreProductsFn } from "@/lib/admin.functions";

export type StoreProduct = Awaited<ReturnType<typeof listStoreProductsFn>>[number];

export function ProductCard({ product }: { product: StoreProduct }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);
  const image = product.image_url ?? getCatalogImage(product.category);

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition hover:-translate-y-1 hover:shadow-lg">
      <div className="relative aspect-square overflow-hidden bg-secondary sm:aspect-auto sm:h-48">
        {!product.in_stock && (
          <span className="absolute left-2 top-2 z-10 rounded-full bg-background/95 px-2 py-1 text-[0.6rem] font-bold uppercase tracking-wide text-muted-foreground sm:left-3 sm:top-3 sm:px-2.5">
            Out of stock
          </span>
        )}
        {product.badge && (
          <span className="absolute right-2 top-2 z-10 rounded-full bg-primary px-2 py-1 text-[0.6rem] font-bold uppercase tracking-wide text-primary-foreground sm:right-3 sm:top-3 sm:px-2.5">
            {product.badge}
          </span>
        )}
        <img
          src={image}
          alt={product.name}
          width={400}
          height={300}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
        />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3 sm:gap-2 sm:p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          <span className="truncate">{product.subcategory ?? product.category}</span>
          {product.strain_type && (
            <Badge variant="outline" className="hidden sm:inline-flex">
              {product.strain_type}
            </Badge>
          )}
        </div>
        <h3 className="line-clamp-2 font-display text-[0.8rem] font-bold uppercase leading-snug sm:text-sm">
          {product.name}
        </h3>
        {/* Phones show two products a row, so the description waits for the larger screen. */}
        <p className="hidden flex-1 text-xs leading-relaxed text-muted-foreground sm:line-clamp-2">
          {product.description}
        </p>
        <div className="mt-auto flex flex-col gap-2 pt-1 sm:mt-2 sm:flex-row sm:items-center sm:justify-between">
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
            {batchNote(product) && (
              <p
                className="mt-0.5 text-[0.65rem] font-semibold text-primary"
                data-testid="batch-note"
              >
                {batchNote(product)}
              </p>
            )}
          </div>
          <Button
            size="sm"
            className="h-10 w-full sm:h-9 sm:w-auto"
            aria-label={`Add ${product.name} to cart`}
            onClick={() => {
              add({
                productId: product.id,
                name: product.name,
                price: product.price_rand,
                unit: product.unit,
                step: saleStep(product),
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
