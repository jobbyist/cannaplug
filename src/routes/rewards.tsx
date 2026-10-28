import { canonical } from "@/lib/site";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Gift, Leaf, Share2, Sparkles, UserPlus } from "lucide-react";
import { Header, Footer } from "@/components/CannaPlugHome";
import { LoyaltyPoster } from "@/components/rewards/LoyaltyPoster";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import {
  EARN_RAND_PER_POINT,
  ONLINE_REDEMPTION_NOTICE,
  REFERRAL_MIN_SPEND,
  REFERRAL_POINTS,
  REWARD_TIERS,
} from "@/lib/rewards-logic";

export const Route = createFileRoute("/rewards")({
  head: () => ({
    links: canonical("/rewards").links,
    meta: [
      ...canonical("/rewards").meta,
      { title: "Loyalty Rewards & Referrals | CannaPlug" },
      {
        name: "description",
        content:
          "Earn 1 point for every R50 you spend at CannaPlug, unlock free Greenhouse and Indoor pre-rolls or buds, and earn more points when your friends join.",
      },
    ],
  }),
  component: RewardsPage,
});

const FAQ = [
  {
    q: "How do I earn points?",
    a: `You earn 1 point for every R${EARN_RAND_PER_POINT} you spend, online and in store. Points are whole numbers (R120 earns 2 points) and are credited when an online order is completed or a purchase is made in store with your membership attached. Delivery fees do not earn points.`,
  },
  {
    q: "What can I get with my points?",
    a: "5 points unlock 1 free Greenhouse pre-roll or bud. 10 points unlock 1 free Indoor pre-roll or bud. A free item is one pre-roll, or 1 g of bud.",
  },
  {
    q: "How do I redeem a reward?",
    a: "Tell the team at the till your username or phone number. They apply the reward to your purchase and the points come off straight away. Online redemption is coming soon.",
  },
  {
    q: "How does the referral program work?",
    a: `Every verified member's username is their referral code. A friend who signs up with your code (or your link) and spends R${REFERRAL_MIN_SPEND} earns you ${REFERRAL_POINTS} point. You earn the point once for each friend.`,
  },
  {
    q: "Where do I find my referral code and link?",
    a: "Sign in, open Account, then Rewards & Loyalty. Your code is your username, and your link opens the sign-up page with your code filled in. You need a verified ID for your code to work.",
  },
  {
    q: "Do I need a username?",
    a: "Yes. New members choose one when they sign up. Existing members can add one in Account, under Rewards & Loyalty. It is unique to you, it is your referral code, and it cannot be changed once chosen.",
  },
  {
    q: "What if I return something or a sale is cancelled?",
    a: "Points earned on a returned or voided purchase are taken back. If a sale that used a reward is voided, the points you spent are returned to you.",
  },
  {
    q: "Do points expire?",
    a: "Not at launch. We will tell members well in advance before that ever changes.",
  },
];

function RewardsPage() {
  const { user } = useAuth();
  return (
    <div className="site">
      <Header />
      <main id="main" className="mx-auto max-w-5xl px-4 pb-20 pt-10 sm:px-6">
        <header className="mb-8 max-w-2xl">
          <p className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-primary">
            <Leaf size={14} /> CannaPlug Loyalty
          </p>
          <h1 className="font-display text-4xl font-extrabold uppercase leading-none sm:text-5xl">
            Earn points. Unlock rewards.
          </h1>
          <p className="mt-4 text-base text-muted-foreground">
            Every R{EARN_RAND_PER_POINT} you spend earns a point. Bring your friends and earn more.
            Your spending, your people, your points.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {user ? (
              <Button asChild size="lg">
                <Link to="/account" hash="rewards">
                  See my points and referral code
                </Link>
              </Button>
            ) : (
              <>
                <Button asChild size="lg">
                  <Link to="/account" search={{ mode: "signup" }}>
                    Join and start earning
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link to="/account">Sign in</Link>
                </Button>
              </>
            )}
          </div>
        </header>

        <LoyaltyPoster panel="both" priority className="mb-12" />

        <section aria-labelledby="earn" className="mb-12">
          <h2
            id="earn"
            className="mb-4 flex items-center gap-2 font-display text-2xl font-extrabold uppercase"
          >
            <Sparkles size={20} className="text-primary" /> Earn
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-card p-6">
              <p className="font-display text-4xl font-extrabold text-primary">
                R{EARN_RAND_PER_POINT} = 1 point
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Spend R{EARN_RAND_PER_POINT} online or in store and earn 1 point. Points are
                credited when an order is completed or you buy in store as a member.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-6">
              <p className="font-display text-4xl font-extrabold text-primary">
                Friend spends R{REFERRAL_MIN_SPEND} = {REFERRAL_POINTS} point
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Every friend who signs up with your code and spends R{REFERRAL_MIN_SPEND} earns you{" "}
                {REFERRAL_POINTS} point.
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="redeem" className="mb-12">
          <h2
            id="redeem"
            className="mb-4 flex items-center gap-2 font-display text-2xl font-extrabold uppercase"
          >
            <Gift size={20} className="text-primary" /> Redeem
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {REWARD_TIERS.map((r) => (
              <div
                key={r.code}
                className="rounded-xl border border-border bg-card p-6"
                data-testid="reward-tier"
              >
                <p className="font-display text-4xl font-extrabold text-primary">
                  {r.points} points
                </p>
                <p className="mt-1 text-base font-semibold">{r.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{r.blurb}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm">
            <b>In store:</b> tell the team your username or phone number at the till and they apply
            the reward.
          </p>
          <p
            data-testid="online-redemption-notice"
            className="mt-2 rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground"
          >
            {ONLINE_REDEMPTION_NOTICE}
          </p>
        </section>

        <section aria-labelledby="refer" className="mb-12">
          <h2
            id="refer"
            className="mb-4 flex items-center gap-2 font-display text-2xl font-extrabold uppercase"
          >
            <Share2 size={20} className="text-primary" /> Refer a friend
          </h2>
          <ol className="grid gap-4 sm:grid-cols-3">
            {[
              {
                icon: UserPlus,
                title: "1. Get your code",
                body: "Choose a username in your account. Once your ID is verified it works as your referral code and link.",
              },
              {
                icon: Share2,
                title: "2. Share it",
                body: "Send your link or code to a friend. The link opens sign-up with your code already filled in.",
              },
              {
                icon: Gift,
                title: "3. Earn a point",
                body: `When your friend joins and spends R${REFERRAL_MIN_SPEND}, you earn ${REFERRAL_POINTS} point. Once per friend.`,
              },
            ].map((s) => (
              <li key={s.title} className="rounded-xl border border-border bg-card p-5">
                <s.icon size={20} className="mb-2 text-primary" />
                <p className="font-semibold">{s.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            Friends must be new members. You cannot refer yourself, and a referral code only works
            for members with a verified ID.
          </p>
        </section>

        <section aria-labelledby="faq" className="mb-12">
          <h2 id="faq" className="mb-4 font-display text-2xl font-extrabold uppercase">
            Questions
          </h2>
          <Accordion
            type="single"
            collapsible
            className="rounded-xl border border-border bg-card px-4"
          >
            {FAQ.map((f, i) => (
              <AccordionItem key={f.q} value={`q${i}`}>
                <AccordionTrigger className="text-left text-sm font-semibold">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                  {f.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>

        <p className="text-center text-xs text-muted-foreground">
          18+ only. Please consume responsibly. Rewards are for members and cannot be exchanged for
          cash.
        </p>
      </main>
      <Footer />
    </div>
  );
}
