import { describe, expect, it } from "vitest";
import {
  EVENTS_AND_PROMOTIONS,
  BLACK_FRIDAY_NOTICE_ENDS,
  BLACK_FRIDAY_PATH,
  BLACK_FRIDAY_SLUG,
  homeEventsAndPromotions,
  mostRecentEventsAndPromotions,
} from "@/lib/events";

describe("events and promotions", () => {
  it("the homepage shows the 3 most recent, newest first: Black Friday, then Ask The Plug (Plug Back is kept off)", () => {
    expect(homeEventsAndPromotions(3).map((e) => e.slug)).toEqual([
      "black-friday",
      "ask-the-plug",
      "halloweed",
    ]);
  });
  it("ordering by date alone still puts Plug Back third, so the homepage skip is deliberate", () => {
    expect(mostRecentEventsAndPromotions(3).map((e) => e.slug)).toEqual([
      "black-friday",
      "ask-the-plug",
      "plug-back",
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
  it("Black Friday is the newest item, has its own post with every poster, and makes no medical claim", () => {
    const b = EVENTS_AND_PROMOTIONS.find((e) => e.slug === BLACK_FRIDAY_SLUG)!;
    expect(b.post).toBe(true);
    expect(b.startsOn).toBe("2026-11-27");
    expect(b.posters).toHaveLength(2);
    expect(b.posters![0]!.image).toBe(b.image);
    expect(BLACK_FRIDAY_PATH).toBe("/events/black-friday");
    expect(b.copy).not.toMatch(/cure|treat|medical benefit/i);
  });
  it("the notice runs to the end of Monday 30 Nov, SAST", () => {
    expect(BLACK_FRIDAY_NOTICE_ENDS).toBe(Date.parse("2026-11-30T22:00:00Z"));
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
