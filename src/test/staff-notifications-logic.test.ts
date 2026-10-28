import { describe, expect, it } from "vitest";
import { canSee } from "@/lib/admin-nav";
import { assignableRoles, canEditRole } from "@/lib/staff-roles";
import {
  effectiveNotice,
  isUnread,
  isoToSastInput,
  nextChangeAt,
  sastToIso,
  sortNotices,
  type TeamNotice,
} from "@/lib/team-notifications";

const notice = (o: Partial<TeamNotice> = {}): TeamNotice => ({
  id: "n1",
  title: "Going live soon",
  body: "Details",
  kind: "update",
  min_role: "budtender",
  status: "published",
  pinned: false,
  published_at: "2026-10-28T08:00:00Z",
  change_at: null,
  change_title: null,
  change_body: null,
  created_at: "2026-10-28T08:00:00Z",
  updated_at: "2026-10-28T08:00:00Z",
  ...o,
});

describe("who may change whose role", () => {
  it("managers handle budtenders only; admins also managers; nobody touches admins or themselves", () => {
    expect(assignableRoles("manager")).toEqual(["budtender"]);
    expect(assignableRoles("admin")).toEqual(["budtender", "manager"]);
    expect(assignableRoles("budtender")).toEqual([]);
    const t = (role: "budtender" | "manager" | "admin" | null) => ({ user_id: "t", role });
    expect(canEditRole("manager", "me", t(null))).toBe(true);
    expect(canEditRole("manager", "me", t("budtender"))).toBe(true);
    expect(canEditRole("manager", "me", t("manager"))).toBe(false);
    expect(canEditRole("manager", "me", t("admin"))).toBe(false);
    expect(canEditRole("admin", "me", t("manager"))).toBe(true);
    expect(canEditRole("admin", "me", t("budtender"))).toBe(true);
    expect(canEditRole("admin", "me", t("admin"))).toBe(false);
    expect(canEditRole("admin", "t", t("budtender"))).toBe(false);
    expect(canEditRole("budtender", "me", t(null))).toBe(false);
    expect(canEditRole(null, "me", t(null))).toBe(false);
  });

  it("the Staff and Notifications tabs are for managers and admins", () => {
    for (const tab of ["staff", "notifications"]) {
      expect(canSee("budtender", tab)).toBe(false);
      expect(canSee("manager", tab)).toBe(true);
      expect(canSee("admin", tab)).toBe(true);
    }
  });
});

describe("notice text and read state", () => {
  const flip = notice({
    change_at: "2026-10-28T22:00:00Z",
    change_title: "Refer-a-friend program is now live!",
    change_body: "Now live.",
  });

  it("shows the scheduled replacement from the moment it is due, not before", () => {
    const before = Date.parse("2026-10-28T21:59:59Z");
    const after = Date.parse("2026-10-28T22:00:00Z");
    expect(effectiveNotice(flip, before)).toMatchObject({
      title: "Going live soon",
      switched: false,
    });
    expect(effectiveNotice(flip, after)).toMatchObject({
      title: "Refer-a-friend program is now live!",
      body: "Now live.",
      switched: true,
    });
    expect(nextChangeAt([flip], before)).toBe(after);
    expect(nextChangeAt([flip], after)).toBeNull();
    expect(nextChangeAt([{ ...flip, status: "draft" }], before)).toBeNull();
  });

  it("is unread until read, and unread again after an edit or the scheduled change", () => {
    const now = Date.parse("2026-10-29T00:10:00+02:00");
    expect(isUnread(notice(), undefined, now)).toBe(true);
    expect(isUnread(notice(), "2026-10-28T09:00:00Z", now)).toBe(false);
    expect(
      isUnread(notice({ updated_at: "2026-10-28T10:00:00Z" }), "2026-10-28T09:00:00Z", now),
    ).toBe(true);
    expect(isUnread(flip, "2026-10-28T09:00:00Z", Date.parse("2026-10-28T21:00:00Z"))).toBe(false);
    expect(isUnread(flip, "2026-10-28T09:00:00Z", Date.parse("2026-10-28T22:05:00Z"))).toBe(true);
    expect(isUnread(flip, "2026-10-28T22:03:00Z", Date.parse("2026-10-28T22:05:00Z"))).toBe(false);
  });

  it("lists pinned first, then newest", () => {
    const list = sortNotices([
      notice({ id: "old", published_at: "2026-10-01T00:00:00Z" }),
      notice({ id: "new", published_at: "2026-10-20T00:00:00Z" }),
      notice({ id: "pin", pinned: true, published_at: "2026-09-01T00:00:00Z" }),
    ]);
    expect(list.map((n) => n.id)).toEqual(["pin", "new", "old"]);
  });

  it("converts South African time (UTC+2, no daylight saving) both ways", () => {
    expect(sastToIso("2026-10-29T00:00")).toBe("2026-10-28T22:00:00.000Z");
    expect(isoToSastInput("2026-10-28T22:00:00Z")).toBe("2026-10-29T00:00");
  });
});
