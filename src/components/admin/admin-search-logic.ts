import type { AdminSearchResults, SearchSale } from "@/lib/admin-search.server";
import { rand } from "@/lib/cart";

export type SearchTab = { id: string; label: string; keywords?: string | undefined };
export type SearchHit =
  | { kind: "tab"; id: string; label: string; detail: string }
  | { kind: "order"; id: string; label: string; detail: string }
  | { kind: "customer"; id: string; label: string; detail: string }
  | { kind: "product"; id: string; label: string; detail: string }
  | { kind: "sale"; id: string; label: string; detail: string; sale: SearchSale };

const status = (s: string) => s.replaceAll("_", " ");

/** Turns the server's grouped results (plus matching tabs) into one keyboard-navigable list. */
export function toHits(q: string, tabs: SearchTab[], r: AdminSearchResults): SearchHit[] {
  const needle = q.trim().toLowerCase();
  const tabHits: SearchHit[] = needle
    ? tabs
        .filter((t) => `${t.label} ${t.keywords ?? ""}`.toLowerCase().includes(needle))
        .slice(0, 4)
        .map((t) => ({ kind: "tab", id: t.id, label: t.label, detail: "Go to tab" }))
    : [];
  return [
    ...tabHits,
    ...r.orders.map<SearchHit>((o) => ({
      kind: "order",
      id: o.id,
      label: o.order_number,
      detail: [
        o.contact_name,
        status(o.status),
        rand(Number(o.total_rand)),
        o.delivery_method === "collection" ? "pickup" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    ...r.customers.map<SearchHit>((c) => ({
      kind: "customer",
      id: c.id,
      label: c.full_name || c.email || "Member",
      detail: [c.phone, c.email, `${c.order_count} order${c.order_count === 1 ? "" : "s"}`]
        .filter(Boolean)
        .join(" · "),
    })),
    ...r.products.map<SearchHit>((p) => ({
      kind: "product",
      id: p.id,
      label: p.name,
      detail: [
        p.sku,
        p.category,
        rand(Number(p.price_rand)),
        `${p.available} available`,
        p.is_active ? null : "inactive",
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    ...r.sales.map<SearchHit>((s) => ({
      kind: "sale",
      id: s.id,
      label: s.receipt_number,
      detail: `Till sale · ${status(s.status)} · ${rand(Number(s.total))}`,
      sale: s,
    })),
  ];
}
