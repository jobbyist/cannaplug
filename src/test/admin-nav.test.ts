import { describe, expect, it } from "vitest";
import { TAB_MIN_ROLE, atLeast, canSee } from "@/lib/admin-nav";

describe("/admin tabs by role", () => {
  it("budtenders see the till, orders, deliveries, ID checks and read-only lists", () => {
    const tabs = Object.keys(TAB_MIN_ROLE)
      .filter((t) => canSee("budtender", t))
      .sort();
    expect(tabs).toEqual([
      "customers",
      "deliveries",
      "id-checks",
      "inventory",
      "orders",
      "overview",
      "pos",
      "products",
    ]);
  });
  it("managers see everything except clinical administration; admins see all; nobody sees anything before the role loads", () => {
    expect(Object.keys(TAB_MIN_ROLE).filter((t) => !canSee("manager", t))).toEqual(["clinical"]);
    expect(canSee("manager", "billing")).toBe(true);
    expect(canSee("budtender", "billing")).toBe(false);
    expect(Object.keys(TAB_MIN_ROLE).every((t) => canSee("admin", t))).toBe(true);
    expect(canSee(null, "overview")).toBe(false);
    expect(canSee("admin", "unknown-tab")).toBe(true);
    expect(canSee("manager", "unknown-tab")).toBe(false);
    expect(atLeast("budtender", "manager")).toBe(false);
  });
});
