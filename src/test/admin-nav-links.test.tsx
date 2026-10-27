// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LayoutGrid, ShieldCheck } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardSidebar, opensElsewhere } from "@/components/dashboard/Sidebar";

afterEach(cleanup);

const items = [
  { id: "overview", icon: LayoutGrid, label: "Overview" },
  { id: "id-checks", icon: ShieldCheck, label: "ID Checks" },
];

describe("admin sidebar links", () => {
  it("are real links to each section, so they can open in a new tab", () => {
    render(
      <DashboardSidebar
        items={items}
        active="overview"
        onSelect={() => {}}
        header={null}
        hrefFor={(id) => (id === "overview" ? "/admin" : `/admin#${id}`)}
      />,
    );
    expect(screen.getByRole("link", { name: "ID Checks" }).getAttribute("href")).toBe(
      "/admin#id-checks",
    );
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("a plain click switches section here; Ctrl/⌘ or middle click is left to the browser", () => {
    const onSelect = vi.fn();
    render(
      <DashboardSidebar
        items={items}
        active="overview"
        onSelect={onSelect}
        header={null}
        hrefFor={(id) => `/admin#${id}`}
      />,
    );
    const link = screen.getByRole("link", { name: "ID Checks" });
    fireEvent.click(link, { ctrlKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledWith("id-checks");
    expect(
      opensElsewhere({ button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }),
    ).toBe(true);
  });

  it("stays as buttons where no links are wanted (account page)", () => {
    render(<DashboardSidebar items={items} active="overview" onSelect={() => {}} header={null} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
