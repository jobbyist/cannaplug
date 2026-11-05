/**
 * The member-portal welcome: which members see it, and what it says. No health or ID data appears here.
 * Since 5 Nov 2026 new members see the "Getting started" checklist (an in-page card), not the popup tour; the
 * tour steps stay for the Help tab copy and older clients.
 */

export const TOUR_FLAG = "onboarding_tour";

export type TourStep = {
  id: string;
  title: string;
  body: string;
  /** Portal tab shown behind the popup for this step. */
  tab?: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to CannaPlug",
    body: "Your member portal is where you verify your ID, track orders and earn rewards. This quick tour takes under a minute, and you can skip it any time.",
    tab: "dashboard",
  },
  {
    id: "verification",
    title: "Verify your ID",
    body: "Upload a photo of your ID once. It is reviewed by hand, and you can order online as soon as it is approved.",
    tab: "verification",
  },
  {
    id: "orders",
    title: "Orders and saved products",
    body: "Follow every order from placed to delivered, and save products you like for later.",
    tab: "orders",
  },
  {
    id: "rewards",
    title: "Rewards and referrals",
    body: "Earn 1 loyalty point for every R50 you spend. Set a username to get your own referral code and link to share with friends.",
    tab: "rewards",
  },
  {
    id: "addresses",
    title: "Delivery addresses",
    body: "Keep your delivery addresses here so checkout takes a few taps.",
    tab: "addresses",
  },
  {
    id: "settings",
    title: "Settings and support",
    body: "Change your password, choose which emails you get, and reach our team from Help & Support whenever you need us.",
    tab: "settings",
  },
];

/** True only for members who signed up with the flag set and have not finished or skipped the tour. */
export function tourPending(user: { user_metadata?: Record<string, unknown> } | null): boolean {
  return user?.user_metadata?.[TOUR_FLAG] === "pending";
}

export type GettingStartedState = {
  /** ID submitted (pending) or approved. */
  idSubmitted: boolean;
  hasUsername: boolean;
  hasAddress: boolean;
};

export type GettingStartedStep = {
  id: string;
  title: string;
  body: string;
  action: string;
  done: boolean;
  tab?: string;
  href?: string;
};

/** The checklist, in the order that unlocks the most: ID first (needed to order), then the extras. */
export function gettingStartedSteps(s: GettingStartedState): GettingStartedStep[] {
  return [
    {
      id: "verify",
      title: "Verify your ID",
      body: "Needed before you can order online. Upload a photo once; it's checked by hand.",
      action: "Verify now",
      done: s.idSubmitted,
      tab: "verification",
    },
    {
      id: "address",
      title: "Add a delivery address",
      body: "So checkout takes a few taps.",
      action: "Add address",
      done: s.hasAddress,
      tab: "addresses",
    },
    {
      id: "username",
      title: "Choose your username",
      body: "It's your referral code: friends who join earn you loyalty points.",
      action: "Choose",
      done: s.hasUsername,
      tab: "rewards",
    },
    {
      id: "shop",
      title: "Browse the menu",
      body: "See what's in stock today.",
      action: "Open the shop",
      done: false,
      href: "/shop",
    },
  ];
}
