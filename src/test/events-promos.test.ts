import { describe, expect, it } from "vitest";
import {
  EVENTS_AND_PROMOTIONS,
  homeEventsAndPromotions,
  mostRecentEventsAndPromotions,
} from "@/lib/events";

describe("events and promotions", () => {
  it("the homepage shows the 3 most recent, newest first, with Ask The Plug replacing Plug Back", () => {
    expect(homeEventsAndPromotions(3).map((e) => e.slug)).toEqual([
      "ask-the-plug",
      "halloweed",
      "weekend-special",
    ]);
  });
  it("ordering by date alone still puts Plug Back second, so the homepage skip is deliberate", () => {
    expect(mostRecentEventsAndPromotions(3).map((e) => e.slug)).toEqual([
      "ask-the-plug",
      "plug-back",
      "halloweed",
    ]);
    expect(EVENTS_AND_PROMOTIONS.find((e) => e.slug === "plug-back")!.onHome).toBe(false);
  });
  it("Ask The Plug uses the launch image and makes no medical claim", () => {
    const a = EVENTS_AND_PROMOTIONS.find((e) => e.slug === "ask-the-plug")!;
    expect(a.image).toMatch(/ask-the-plug-launch/);
    expect(a.copy).toMatch(/not medical advice/i);
    expect(a.copy).toMatch(/18\+/);
    expect(a.startsOn).toBe("2026-10-31");
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
