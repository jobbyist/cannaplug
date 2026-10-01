import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { rand } from "@/lib/cart";
import type { MemberAccount } from "@/lib/member-data.server";
import { describeLoyaltyTxn, pointsValueRand, tierProgress } from "@/lib/member-logic";

export function RewardsPanel({ account }: { account: MemberAccount }) {
  const { loyalty } = account;
  const progress = tierProgress(loyalty.lifetime, loyalty.tiers);
  const { rules } = loyalty;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold uppercase">Rewards & loyalty</h2>
          {progress.current && <Badge>{progress.current.name}</Badge>}
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Earn 1 point for every {rand(rules.earnRandPerPoint)} you spend. Points are credited when
          an order is completed or a purchase is made in store, and can be redeemed against an
          unpaid order (minimum {rules.minRedeemPoints} points, up to {rules.maxRedeemPct}% of the
          order).
        </p>
        <p className="font-display text-3xl font-extrabold">{loyalty.balance}</p>
        <p className="mb-4 text-xs text-muted-foreground">
          points available · worth {rand(pointsValueRand(Math.max(loyalty.balance, 0), rules))}
        </p>
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
