import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Check, RotateCcw, ShoppingBag } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCart } from "@/lib/cart";
import { categories, products, type Product } from "@/lib/mock-data";
import { rand } from "@/lib/cart";

export const Route = createFileRoute("/shop")({
  head: () => ({
    meta: [
      { title: "Shop | CannaPlug" },
      {
        name: "description",
        content:
          "Browse CannaPlug's curated cannabis catalogue — flower, edibles, vapes, concentrates and accessories. Filter by category, strain type, price and availability.",
      },
    ],
  }),
  component: ShopPage,
});

const strainTypes = ["All", "Indica", "Sativa", "Hybrid"] as const;
type StrainFilter = (typeof strainTypes)[number];

const PRICE_MIN = Math.min(...products.map((p) => p.price_rand));
const PRICE_MAX = Math.max(...products.map((p) => p.price_rand));

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
        {!product.in_stock && (
          <span className="absolute left-3 top-3 z-10 rounded-full bg-charcoal/80 px-2.5 py-1 text-[0.6rem] font-bold uppercase tracking-wide text-white">
            Out of stock
          </span>
        )}
        <img
          src={product.image}
          alt={product.name}
          loading="lazy"
          className={
            "h-full w-full object-cover transition duration-500 group-hover:scale-105" +
            (product.in_stock ? "" : " opacity-60 grayscale")
          }
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
            <b className="text-sm">{rand(product.price_rand)}</b>
            {product.unit && (
              <span className="ml-1 text-[0.65rem] text-muted-foreground">/ {product.unit}</span>
            )}
          </div>
          <Button
            size="sm"
            disabled={!product.in_stock}
            aria-label={
              product.in_stock ? `Add ${product.name} to cart` : `${product.name} is out of stock`
            }
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
            {!product.in_stock ? (
              "Out of stock"
            ) : added ? (
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
  const [strainType, setStrainType] = useState<StrainFilter>("All");
  const [priceRange, setPriceRange] = useState<[number, number]>([PRICE_MIN, PRICE_MAX]);
  const [inStockOnly, setInStockOnly] = useState(false);

  const filtered = useMemo(
    () =>
      products.filter(
        (p) =>
          (category === "All" || p.category === category) &&
          (strainType === "All" || p.strain_type === strainType) &&
          p.price_rand >= priceRange[0] &&
          p.price_rand <= priceRange[1] &&
          (!inStockOnly || p.in_stock),
      ),
    [category, strainType, priceRange, inStockOnly],
  );

  const filtersActive =
    category !== "All" ||
    strainType !== "All" ||
    inStockOnly ||
    priceRange[0] !== PRICE_MIN ||
    priceRange[1] !== PRICE_MAX;

  const resetFilters = () => {
    setCategory("All");
    setStrainType("All");
    setPriceRange([PRICE_MIN, PRICE_MAX]);
    setInStockOnly(false);
  };

  return (
    <div className="site">
      <Header />
      <main className="mx-auto w-full max-w-[1180px] px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-8">
          <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary">
            Curated selection
          </p>
          <h1 className="mt-2 font-display text-3xl font-extrabold uppercase sm:text-4xl">
            Shop the full menu
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Lab-tested flower, edibles, vapes, concentrates and accessories — every item added
            straight to your cart.
          </p>
        </div>

        <div className="mb-6 flex flex-wrap gap-2">
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

        <div className="mb-8 grid grid-cols-1 gap-5 rounded-xl border border-border bg-card p-5 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.4fr_auto] lg:items-end">
          <div className="grid gap-1.5">
            <Label
              htmlFor="strain-filter"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Strain type
            </Label>
            <Select
              value={strainType}
              onValueChange={(value) => setStrainType(value as StrainFilter)}
            >
              <SelectTrigger id="strain-filter" aria-label="Filter by strain type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {strainTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-end gap-2 pb-2.5">
            <Checkbox
              id="in-stock-filter"
              checked={inStockOnly}
              onCheckedChange={(checked) => setInStockOnly(checked === true)}
            />
            <Label
              htmlFor="in-stock-filter"
              className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              In stock only
            </Label>
          </div>

          <div className="grid gap-1.5">
            <Label className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>Price range</span>
              <span className="text-foreground">
                {rand(priceRange[0])} – {rand(priceRange[1])}
              </span>
            </Label>
            <Slider
              min={PRICE_MIN}
              max={PRICE_MAX}
              step={10}
              value={priceRange}
              onValueChange={(value) =>
                setPriceRange([value[0] ?? PRICE_MIN, value[1] ?? PRICE_MAX])
              }
              className="py-2"
              aria-label="Filter by price range"
            />
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={resetFilters}
            disabled={!filtersActive}
            className="justify-self-start lg:justify-self-end"
          >
            <RotateCcw size={13} /> Clear filters
          </Button>
        </div>

        <p className="mb-4 text-xs text-muted-foreground">
          Showing {filtered.length} of {products.length} products
        </p>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">No products match your filters.</p>
            <Button variant="outline" size="sm" onClick={resetFilters}>
              <RotateCcw size={13} /> Clear filters
            </Button>
          </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
