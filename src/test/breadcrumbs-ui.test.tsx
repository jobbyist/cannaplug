// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const loc = vi.hoisted(() => ({ pathname: "/shop", searchStr: "?category=Flower" }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: unknown }) => (
    <a href={to}>{children as never}</a>
  ),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: loc.pathname, searchStr: loc.searchStr } }),
}));

import { Breadcrumbs } from "@/components/Breadcrumbs";

afterEach(cleanup);

describe("Breadcrumbs", () => {
  it("shows the trail for the current address: links up, the current page marked and not a link", () => {
    loc.pathname = "/shop";
    loc.searchStr = "?category=Flower";
    render(<Breadcrumbs />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(within(nav).getByRole("link", { name: "Catalog" }).getAttribute("href")).toBe("/shop");
    const current = within(nav).getByText("Flower");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.closest("a")).toBeNull();
  });

  it("publishes a BreadcrumbList for search engines", () => {
    loc.pathname = "/journal/hello-world";
    loc.searchStr = "";
    const { container } = render(<Breadcrumbs />);
    const ld = JSON.parse(
      container.querySelector('script[type="application/ld+json"]')!.textContent!,
    );
    expect(ld["@type"]).toBe("BreadcrumbList");
    expect(ld.itemListElement).toHaveLength(3);
  });

  it("renders nothing on the home page, and takes a trail from pages without their own route (admin tabs)", () => {
    loc.pathname = "/";
    loc.searchStr = "";
    const { container, rerender } = render(<Breadcrumbs />);
    expect(container.innerHTML).toBe("");
    loc.pathname = "/admin";
    rerender(
      <Breadcrumbs
        bare
        trail={[{ label: "Home", to: "/" }, { label: "Admin" }, { label: "Customers" }]}
      />,
    );
    expect(screen.getByText("Customers").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Admin").closest("a")).toBeNull();
  });
});
