import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Check, ShoppingBag } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCart } from "@/lib/cart";
import { categories, products, type Product } from "@/lib/mock-data";
import { rand } from "@/lib/cart";

export const Route = createFileRoute("/shop")({
  head: () => ({
    meta: [
      { title: "Shop | CannaPlug" },
      { name: "description", content: "Browse CannaPlug's curated cannabis catalogue — flower, edibles, vapes, concentrates and accessories." },
    ],
  }),
  component: ShopPage,
});

function ProductCard({ product }: { product: Product }) {
  const { add } = useCart();
  const [added, setAdded] = useState(false);

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition hover:-translate-y-1 hover:shadow-lg">
      <div className="relative h-48 overflow-hidden bg-secondary">
        {product.badge && (
          <span className="absolute right-3 top-3 z-10 rounded-full bg-primary px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-wide text-primary-foreground">
            {product.badge}
          </span>
        )}
        <img
          src={product.image}
          alt={product.name}
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
        <p className="line-clamp-2 flex-1 text-xs leading-relaxed text-muted-foreground">{product.description}</p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div>
            <b className="text-sm">{rand(product.price_rand)}</b>
            {product.unit && <span className="ml-1 text-[0.65rem] text-muted-foreground">/ {product.unit}</span>}
          </div>
          <Button
            size="sm"
            aria-label={`Add ${product.name} to cart`}
            onClick={() => {
              add({ productId: product.id, name: product.name, price: product.price_rand, unit: product.unit });
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

function ShopPage() {
  const [category, setCategory] = useState<(typeof categories)[number]>("All");

  const filtered = useMemo(
    () => (category === "All" ? products : products.filter((p) => p.category === category)),
    [category],
  );

  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[1180px] px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-8">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">Curated selection</p>
          <h1 className="mt-2 font-display text-3xl font-extrabold uppercase sm:text-4xl">Shop the full menu</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Lab-tested flower, edibles, vapes, concentrates and accessories — every item added straight to your cart.
          </p>
        </div>

        <div className="mb-8 flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={
                "rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-wide transition " +
                (category === c
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground hover:border-primary hover:text-primary")
              }
            >
              {c}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">No products in this category yet.</p>
        )}
      </main>
      <Footer />
    </div>
  );
}
