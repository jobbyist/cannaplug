import { Sparkles } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { rand } from "@/lib/cart";
import type { MemberAccount } from "@/lib/member-data.server";
import { describeLoyaltyTxn, tierProgress } from "@/lib/member-logic";
import { EARN_RAND_PER_POINT, ONLINE_REDEMPTION_NOTICE, nextReward } from "@/lib/rewards-logic";
import { LoyaltyPoster, SeeProgramLink } from "@/components/rewards/LoyaltyPoster";
import { ReferralCard } from "./ReferralCard";

export function RewardsPanel({
  account,
  reload,
  onVerify,
}: {
  account: MemberAccount;
  reload?: () => Promise<void> | void;
  onVerify?: () => void;
}) {
  const { loyalty, rewards } = account;
  const progress = tierProgress(loyalty.lifetime, loyalty.tiers);
  const balance = Math.max(loyalty.balance, 0);
  const catalogue = rewards.rewards.map((r) => ({ ...r, points: r.points_cost }));
  const next = nextReward(balance, catalogue);
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold uppercase">Rewards & loyalty</h2>
          {progress.current && <Badge>{progress.current.name}</Badge>}
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Earn 1 point for every {rand(EARN_RAND_PER_POINT)} you spend, online or in store. Points
          are credited when an order is completed or a purchase is made in store.
        </p>
        <p className="font-display text-3xl font-extrabold" data-testid="points-balance">
          {loyalty.balance}
        </p>
        <p className="mb-4 text-xs text-muted-foreground">points available</p>
        {next ? (
          <p className="mb-2 text-sm" data-testid="next-reward">
            <b>{next.pointsToGo}</b> more point{next.pointsToGo === 1 ? "" : "s"} to unlock a{" "}
            {next.name.toLowerCase()}.
          </p>
        ) : (
          <p className="mb-2 text-sm font-semibold text-primary">
            You have enough points for every reward.
          </p>
        )}
        {progress.next ? (
          <>
            <div className="mb-2 flex justify-between text-xs font-semibold">
              <span>{progress.current?.name ?? "Member"}</span>
              <span>
                {progress.next.name} · {progress.pointsToNext} points to go
              </span>
            </div>
            <Progress value={progress.percent} />
          </>
        ) : (
          <p className="text-xs font-semibold text-primary">You&apos;ve reached the top tier.</p>
        )}
        {loyalty.balance < 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            A returned or voided purchase reversed points you had already used. New points will
            first clear this balance.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-6" data-testid="rewards-list">
        <h3 className="mb-3 font-display text-sm font-bold uppercase">Rewards you can unlock</h3>
        <ul className="divide-y divide-border text-sm">
          {rewards.rewards.map((r) => {
            const ready = balance >= r.points_cost;
            return (
              <li key={r.code} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <p className="font-semibold">{r.name}</p>
                  <p className="text-xs text-muted-foreground">{r.description}</p>
                </div>
                <div className="text-right">
                  <p className="font-display text-lg font-extrabold">{r.points_cost} points</p>
                  <p
                    className={
                      "text-xs font-semibold " + (ready ? "text-primary" : "text-muted-foreground")
                    }
                  >
                    {ready ? "Ready to redeem" : `${r.points_cost - balance} to go`}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 rounded-lg bg-primary/5 p-3 text-xs">
          <b>How to redeem:</b> in store, tell the team your username
          {account.rewards.username ? (
            <>
              {" "}
              (<span className="font-mono">{account.rewards.username}</span>)
            </>
          ) : null}{" "}
          or phone number at the till. They apply the reward and the points come off straight away.
        </p>
        <p
          data-testid="online-redemption-notice"
          className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground"
        >
          <Sparkles size={13} className="mt-0.5 shrink-0 text-primary" /> {ONLINE_REDEMPTION_NOTICE}
        </p>
      </div>

      <ReferralCard
        summary={rewards}
        onChanged={async () => void (await reload?.())}
        {...(onVerify ? { onVerify } : {})}
      />

      <div className="rounded-xl border border-border bg-card p-4">
        <LoyaltyPoster panel="both" />
        <div className="mt-3 text-center">
          <SeeProgramLink />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-3 font-display text-sm font-bold uppercase">Tiers</h3>
        <ul className="divide-y divide-border text-sm">
          {loyalty.tiers.map((tier) => (
            <li key={tier.code} className="flex items-start justify-between gap-3 py-2.5">
              <div>
                <p
                  className={
                    "font-semibold " + (tier.code === loyalty.tierCode ? "text-primary" : "")
                  }
                >
                  {tier.name}
                </p>
                <p className="text-xs text-muted-foreground">{tier.perks.join(" · ")}</p>
              </div>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {tier.min_lifetime_points === 0
                  ? "Start"
                  : `${tier.min_lifetime_points}+ points earned`}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-border bg-card p-6">
        <h3 className="mb-3 font-display text-sm font-bold uppercase">Points activity</h3>
        {loyalty.transactions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No points activity yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {loyalty.transactions.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <p className="text-xs font-semibold">{describeLoyaltyTxn(t.source_type)}</p>
                  <p className="text-[0.65rem] text-muted-foreground">
                    {new Date(t.created_at).toLocaleDateString("en-ZA")}
                  </p>
                </div>
                <div className="text-right">
                  <p className={"font-bold " + (t.points > 0 ? "text-primary" : "")}>
                    {t.points > 0 ? "+" : ""}
                    {t.points}
                  </p>
                  <p className="text-[0.65rem] text-muted-foreground">balance {t.balance_after}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
