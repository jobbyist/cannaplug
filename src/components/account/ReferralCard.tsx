import { useState } from "react";
import { Check, Copy, MessageCircle, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RewardsSummary } from "@/lib/rewards-data.server";
import { referralLink, referralShareText } from "@/lib/rewards-logic";
import { UsernameForm } from "./UsernameForm";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The member's referral program: choose a username (their code), see their code and link, share it, and see how
 * their referrals are going. The code works once the member has a verified ID (staff always can).
 */
export function ReferralCard({
  summary,
  onChanged,
  onVerify,
  origin,
}: {
  summary: RewardsSummary;
  onChanged: () => Promise<void> | void;
  onVerify?: () => void;
  origin?: string;
}) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const base =
    origin ??
    (typeof window !== "undefined" ? window.location.origin : "https://cannaplug012.co.za");
  const flash = (what: "code" | "link") => {
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  };

  const { username, can_refer: canRefer } = summary;
  const link = username ? referralLink(base, username) : "";
  const qualified = summary.referred.filter((r) => r.status === "qualified").length;

  return (
    <div className="rounded-xl border border-border bg-card p-6" data-testid="referral-card">
      <h3 className="mb-1 flex items-center gap-2 font-display text-sm font-bold uppercase">
        <Users size={15} className="text-primary" /> Refer a friend
      </h3>
      <p className="mb-4 text-sm text-muted-foreground">
        Earn {summary.referral_points} loyalty point for every friend who signs up with your code
        and spends R{summary.referral_min_spend}.
      </p>

      {!username && (
        <div className="rounded-lg border border-dashed border-border p-4">
          <p className="mb-3 text-sm">
            Your username is your referral code. Choose it now to start referring friends.
          </p>
          <UsernameForm onSaved={onChanged} />
        </div>
      )}

      {username && !canRefer && (
        <div className="rounded-lg border border-[#D4AF37]/60 bg-[#D4AF37]/10 p-4 text-sm">
          <p className="mb-1 font-semibold">
            Your referral code <span className="font-mono">{username}</span> is not active yet
          </p>
          <p className="mb-3 text-xs text-muted-foreground">
            Referral codes work for members whose ID has been verified. Verify your ID and your code
            switches on by itself.
          </p>
          {onVerify && (
            <Button size="sm" onClick={onVerify}>
              <ShieldCheck size={14} /> Verify my ID
            </Button>
          )}
        </div>
      )}

      {username && canRefer && (
        <div className="grid gap-3">
          <div className="grid gap-1">
            <p className="text-xs font-semibold uppercase text-muted-foreground">
              Your referral code
            </p>
            <div className="flex items-center gap-2">
              <code
                data-testid="referral-code"
                className="flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm"
              >
                {username}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => (await copyText(username)) && flash("code")}
              >
                {copied === "code" ? <Check size={14} /> : <Copy size={14} />} Copy
              </Button>
            </div>
          </div>
          <div className="grid gap-1">
            <p className="text-xs font-semibold uppercase text-muted-foreground">
              Your referral link
            </p>
            <div className="flex items-center gap-2">
              <code
                data-testid="referral-link"
                className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
              >
                {link}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => (await copyText(link)) && flash("link")}
              >
                {copied === "link" ? <Check size={14} /> : <Copy size={14} />} Copy
              </Button>
            </div>
          </div>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(referralShareText(link, username))}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-full border border-border px-4 py-2 text-xs font-semibold hover:bg-muted"
          >
            <MessageCircle size={14} /> Share on WhatsApp
          </a>
        </div>
      )}

      {username && (
        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            Your referrals
          </p>
          {summary.referred.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No one has signed up with your code yet.
            </p>
          ) : (
            <>
              <p className="mb-2 text-sm">
                {summary.referred.length} friend{summary.referred.length === 1 ? "" : "s"} joined ·{" "}
                <b>{qualified}</b> spent R{summary.referral_min_spend} ·{" "}
                <b>{summary.points_from_referrals}</b> point
                {summary.points_from_referrals === 1 ? "" : "s"} earned
              </p>
              <ul className="divide-y divide-border text-sm">
                {summary.referred.map((r, i) => (
                  <li
                    key={`${r.joined_at}-${i}`}
                    className="flex items-center justify-between py-2"
                  >
                    <span>{r.name}</span>
                    <span
                      className={
                        "text-xs " +
                        (r.status === "qualified"
                          ? "font-semibold text-primary"
                          : "text-muted-foreground")
                      }
                    >
                      {r.status === "qualified"
                        ? "Spent R50 · point earned"
                        : "Joined · waiting for their first R50"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
