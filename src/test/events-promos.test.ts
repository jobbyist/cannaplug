import { describe, expect, it } from "vitest";
import { EVENTS_AND_PROMOTIONS, mostRecentEventsAndPromotions } from "@/lib/events";

describe("events and promotions", () => {
  it("surfaces only the 3 most recent, newest first", () => {
    const top = mostRecentEventsAndPromotions(3);
    expect(top.map((e) => e.slug)).toEqual(["plug-back", "halloweed", "weekend-special"]);
  });
  it("the events page still lists everything", () => {
    expect(EVENTS_AND_PROMOTIONS.length).toBeGreaterThan(3);
  });
  it("Plug Back uses the bundled campaign image", () => {
    const pb = EVENTS_AND_PROMOTIONS.find((e) => e.slug === "plug-back")!;
    expect(pb.image).toMatch(/plug-back-campaign/);
    expect(pb.image).not.toContain("__l5e");
  });
});
