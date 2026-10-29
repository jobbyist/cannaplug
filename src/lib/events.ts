import propagandaImage from "@/assets/event-propaganda.jpg";
import plugCupImage from "@/assets/event-plug-cup.jpg";
import weekendSpecialImage from "@/assets/promo-weekend-special.jpg";
import plugBackImage from "@/assets/plug-back-campaign.jpg";
import halloweedImage from "@/assets/promo-halloweed.jpg";

export type EventPromo = {
  slug: string;
  kind: "Event" | "Promotion";
  tag: string;
  title: string;
  when: string;
  /** ISO date the item started (or, for a standing promotion, its latest run); drives "most recent". */
  startsOn: string;
  where?: string;
  copy: string;
  image: string;
  imageAlt: string;
  width?: number;
  height?: number;
};

export const EVENTS_AND_PROMOTIONS: EventPromo[] = [
  {
    slug: "propaganda",
    startsOn: "2026-09-26",
    kind: "Event",
    tag: "Past event",
    title: "Propaganda: 25K The Plug x CannaPlug",
    when: "26 September 2026",
    where: "Propaganda",
    copy: "Customers who spent R300 in store in one sitting got a free ticket to the event.",
    image: propagandaImage,
    imageAlt:
      "Are you loyal to the plug? Spend R300 in store in one sitting and get a free ticket. 26 September 2026, Propaganda.",
    width: 1024,
    height: 1280,
  },
  {
    slug: "plug-cup",
    startsOn: "2026-08-29",
    kind: "Event",
    tag: "Past event",
    title: "The Plug Cup",
    when: "29 August 2026",
    where: "CannaPlug, Pretoria Central",
    copy: "A 16-player EA FC 26 knockout tournament. 16 players. 1 winner. The R150 entry fee included 1 free Greenhouse order and a dab hit.",
    image: plugCupImage,
    imageAlt:
      "The Plug Cup: 16 players, 1 winner, EA Sports FC 26 knockout tournament, 29 August 2026, R150 entry including a free Greenhouse order and a dab hit.",
    width: 854,
    height: 1280,
  },
  {
    slug: "weekend-special",
    startsOn: "2026-10-23",
    kind: "Promotion",
    tag: "Every weekend",
    title: "Weekend Special",
    when: "Friday to Sunday only",
    copy: "Indoor bud and pre-rolls on sale for R70.",
    image: weekendSpecialImage,
    imageAlt: "CannaPlug Weekend Special: indoor bud and pre-rolls for R70, Friday to Sunday only.",
    width: 1024,
    height: 1536,
  },
  {
    slug: "halloweed",
    startsOn: "2026-10-25",
    kind: "Promotion",
    tag: "25 – 31 Oct",
    title: "Halloweed: Trick or Treat",
    when: "25 October – 31 October 2026",
    copy: "Get 30% off all edibles. Scary pricing, all week.",
    image: halloweedImage,
    imageAlt: "Halloweed: Trick or Treat. 30% off all edibles, 25 to 31 October.",
    width: 1024,
    height: 1536,
  },
  {
    slug: "plug-back",
    startsOn: "2026-10-29",
    kind: "Promotion",
    tag: "Now on",
    title: "Plug Back",
    when: "In store while stocks last",
    copy: "Bring 10 empty CannaPlug pre-roll tubes in store and get 1 complimentary Greenhouse pre-roll. Original CannaPlug tubes only.",
    image: plugBackImage,
    width: 1080,
    height: 1080,
    imageAlt:
      "Plug Back: bring 10 empty CannaPlug pre-roll tubes and get 1 free Greenhouse pre-roll.",
  },
];

/** Newest first by start date (stable for ties). */
export function mostRecentEventsAndPromotions(limit: number): EventPromo[] {
  return [...EVENTS_AND_PROMOTIONS]
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn))
    .slice(0, limit);
}
