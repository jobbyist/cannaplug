import { canonical } from "@/lib/site";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { ShopView } from "@/components/shop/ShopView";
import type { StoreProduct } from "@/components/shop/ProductCard";
import { listStoreProductsFn } from "@/lib/admin.functions";
import { parseShopSearch, shopHeading, type ShopSearch } from "@/lib/shop-filter";

export const Route = createFileRoute("/shop")({
  head: ({ match }) => {
    const s = match.search as ShopSearch;
    const params = new URLSearchParams();
    if (s.category) params.set("category", s.category);
    if (s.category && s.sub) params.set("sub", s.sub);
    const qs = params.toString();
    const c = canonical(qs ? `/shop?${qs}` : "/shop");
    const { title, description } = shopHeading(s);
    return {
      links: c.links,
      meta: [...c.meta, { title }, { name: "description", content: description }],
    };
  },
  validateSearch: (search: Record<string, unknown>): ShopSearch => parseShopSearch(search),
  component: ShopPage,
});

function ShopPage() {
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/shop" });

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    listStoreProductsFn()
      .then(setProducts)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const onSearch = useCallback(
    (next: ShopSearch) => void navigate({ search: next, replace: true }),
    [navigate],
  );

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
            Live catalogue from the CannaPlug store.
          </p>
        </div>
        <ShopView
          products={products}
          loading={loading}
          error={error}
          onRetry={load}
          search={search}
          onSearch={onSearch}
        />
      </main>
      <Footer />
    </div>
  );
}
