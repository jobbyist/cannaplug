import propagandaImage from "@/assets/event-propaganda.jpg";
import plugCupImage from "@/assets/event-plug-cup.jpg";
import weekendSpecialImage from "@/assets/promo-weekend-special.jpg";
import plugBackImage from "@/assets/plug-back-campaign.jpg";
import halloweedImage from "@/assets/promo-halloweed.jpg";
import askThePlugImage from "@/assets/ask-the-plug-launch.jpg";
import blackFridaySquare from "@/assets/black-friday-poster-square.jpg";
import blackFridayStory from "@/assets/black-friday-poster-story.jpg";

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
  /** False keeps a live item on /events but off the homepage section (default: shown). */
  onHome?: boolean;
  width?: number;
  height?: number;
  /** True when the item has its own post page at /events/<slug>. */
  post?: boolean;
  /** Every poster shown on the post page (the cover is the first). */
  posters?: { image: string; alt: string; width: number; height: number }[];
};

/** Black Friday + Cyber Monday 2026: the post, and the notice above the header, run to the end of Monday 30 Nov (SAST). */
export const BLACK_FRIDAY_SLUG = "black-friday";
export const BLACK_FRIDAY_PATH = `/events/${BLACK_FRIDAY_SLUG}`;
export const BLACK_FRIDAY_NOTICE_ENDS = Date.parse("2026-12-01T00:00:00+02:00");

export const EVENTS_AND_PROMOTIONS: EventPromo[] = [
  {
    slug: BLACK_FRIDAY_SLUG,
    startsOn: "2026-11-27",
    kind: "Promotion",
    tag: "27 – 30 Nov",
    title: "Black Friday + Cyber Monday",
    when: "Friday 27 – Monday 30 November 2026",
    where: "In store and online (collect in store)",
    copy: "In-store deals all weekend and online-only prices to order and collect. Double loyalty points on online orders, and Double Plug Back. While stocks last.",
    image: blackFridaySquare,
    imageAlt:
      "CannaPlug Black Friday and Cyber Monday, 27 to 30 November: in-store deals Friday to Sunday and online-only deals Friday to Monday.",
    width: 1080,
    height: 1080,
    post: true,
    posters: [
      {
        image: blackFridaySquare,
        alt: "Black Friday and Cyber Monday deals at CannaPlug: in-store Friday to Sunday, online Friday to Monday.",
        width: 1080,
        height: 1080,
      },
      {
        image: blackFridayStory,
        alt: "Black Friday deals, 27 to 30 November: Top Shelf flower 25% off, Greenhouse pre-rolls 2+1, Double Plug Back, accessories 20% off, plus online-only Entry Indoor R70/g, edibles 20% off, double loyalty points and Greendoor R55/g on Cyber Monday.",
        width: 900,
        height: 1600,
      },
    ],
  },
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
    slug: "ask-the-plug",
    startsOn: "2026-10-31",
    kind: "Promotion",
    tag: "Now live",
    title: "Ask The Plug 🔌",
    when: "Launched 31 October 2026",
    copy: "Tell us what you are after and Ask The Plug suggests products that are in stock right now. Members sign in to chat. Guidance only, not medical advice. For adults 18+.",
    image: askThePlugImage,
    imageAlt:
      "Ask The Plug: chat with the Plug to find what suits you. Guidance only, not medical advice. For adults 18+. Members sign in to chat at cannaplug012.co.za.",
    width: 1080,
    height: 1080,
  },
  {
    slug: "plug-back",
    startsOn: "2026-10-29",
    onHome: false, // replaced on the homepage by Ask The Plug (31 Oct 2026); still listed on /events
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

/** What the homepage section shows: newest first, skipping items kept off the homepage. */
export function homeEventsAndPromotions(limit: number): EventPromo[] {
  return mostRecentEventsAndPromotions(EVENTS_AND_PROMOTIONS.length)
    .filter((e) => e.onHome !== false)
    .slice(0, limit);
}

/** Newest first by start date (stable for ties). */
export function mostRecentEventsAndPromotions(limit: number): EventPromo[] {
  return [...EVENTS_AND_PROMOTIONS]
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn))
    .slice(0, limit);
}
