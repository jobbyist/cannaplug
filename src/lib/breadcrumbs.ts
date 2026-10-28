/**
 * Breadcrumb trails for every page: where you are and the way back up. Pure (no router), so it can be tested; the
 * component turns each crumb into a link. A crumb without `to` is the current page.
 */
export type CrumbTo =
  "/" | "/shop" | "/journal" | "/account" | "/events" | "/about" | "/rewards" | "/gallery" | "/faq";
export type Crumb = { label: string; to?: CrumbTo; search?: { category?: string } };

const HOME: Crumb = { label: "Home", to: "/" };

/** Pages whose label is fixed. Anything not listed gets a readable label made from its address. */
const STATIC: Record<string, string> = {
  "/shop": "Catalog",
  "/events": "Events & Promotions",
  "/journal": "Journal",
  "/about": "About",
  "/faq": "FAQ",
  "/rewards": "Rewards",
  "/gallery": "Gallery",
  "/calendar": "Calendar",
  "/checkout": "Checkout",
  "/account": "Account",
  "/member/documents": "My documents",
  "/privacy-policy": "Privacy policy",
  "/refund-policy": "Refund policy",
  "/delivery-policy": "Delivery policy",
  "/terms-of-service": "Terms of service",
  "/payment/return": "Payment",
  "/unsubscribe": "Unsubscribe",
  "/doctor": "Practitioner portal",
  "/admin": "Admin",
};

/** "cannabis-etiquette-south-africa" -> "Cannabis etiquette south africa" (a slug is all we know before the page loads). */
export function labelFromSlug(slug: string): string {
  const words = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Page";
}

const NONE: Crumb[] = [];

/**
 * The trail for a page. Empty on the home page and on pages that are not part of the site (the offline page, receipts,
 * payment webhooks). `search` is the raw query string, used for the catalog's category.
 */
export function breadcrumbsFor(pathname: string, search = ""): Crumb[] {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/offline" || path.startsWith("/api") || path.startsWith("/billing"))
    return NONE;
  if (/^\/admin\/pos\/receipt\//.test(path) || path.startsWith("/subscribe")) return NONE;

  if (path === "/shop") {
    const q = new URLSearchParams(search);
    const category = q.get("category")?.trim();
    const sale = q.get("sale") === "true";
    const trail: Crumb[] = [HOME];
    if (category || sale) {
      trail.push({ label: STATIC["/shop"]!, to: "/shop" });
      trail.push({ label: category ? category : "Specials" });
    } else {
      trail.push({ label: STATIC["/shop"]! });
    }
    return trail;
  }

  const journal = /^\/journal\/([^/]+)$/.exec(path);
  if (journal) {
    return [
      HOME,
      { label: STATIC["/journal"]!, to: "/journal" },
      { label: labelFromSlug(journal[1]!) },
    ];
  }

  if (path === "/member/documents") {
    return [HOME, { label: STATIC["/account"]!, to: "/account" }, { label: "My documents" }];
  }

  if (/^\/verify\/[^/]+$/.test(path)) return [HOME, { label: "Verify a document" }];

  const known = STATIC[path];
  if (known) return [HOME, { label: known }];

  // An address we do not know (a new page): a readable last crumb rather than nothing.
  const last = path.split("/").filter(Boolean).pop() ?? "";
  return [HOME, { label: labelFromSlug(last) }];
}

/** schema.org BreadcrumbList, so search engines can show the trail. `origin` is the site's address. */
export function breadcrumbJsonLd(trail: Crumb[], origin: string, pathname: string) {
  if (trail.length < 2) return null;
  const hrefFor = (c: Crumb, isLast: boolean) =>
    isLast ? pathname : c.to === "/" ? "/" : (c.to ?? pathname);
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.label,
      item: `${origin.replace(/\/$/, "")}${hrefFor(c, i === trail.length - 1)}`,
    })),
  };
}
