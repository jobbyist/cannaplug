import { Link } from "@tanstack/react-router";
import loyaltyEarn from "@/assets/loyalty-earn.jpg";
import loyaltyRedeem from "@/assets/loyalty-redeem.jpg";
import loyaltyProgram from "@/assets/loyalty-program.jpg";

/** The CannaPlug Loyalty posters: both panels together, or one panel at a time. */
export function LoyaltyPoster({
  panel = "both",
  className = "",
  priority = false,
}: {
  panel?: "both" | "earn" | "redeem";
  className?: string;
  priority?: boolean;
}) {
  const src = panel === "earn" ? loyaltyEarn : panel === "redeem" ? loyaltyRedeem : loyaltyProgram;
  const alt =
    panel === "earn"
      ? "CannaPlug Loyalty: R50 spent equals 1 point, and every friend who signs up as a member and spends R50 earns you 1 point."
      : panel === "redeem"
        ? "Redeem your points: 5 points for 1 free Greenhouse pre-roll or bud, 10 points for 1 free Indoor pre-roll or bud."
        : "CannaPlug Loyalty. Earn points, unlock rewards: R50 spent equals 1 point, a referred friend who spends R50 earns you 1 point, 5 points for a free Greenhouse pre-roll or bud and 10 points for a free Indoor pre-roll or bud.";
  return (
    <img
      src={src}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      className={`h-auto w-full rounded-2xl ${className}`}
    />
  );
}

export function SeeProgramLink({ className = "" }: { className?: string }) {
  return (
    <Link
      to="/rewards"
      className={`text-xs font-semibold text-primary underline-offset-2 hover:underline ${className}`}
    >
      See how rewards and referrals work
    </Link>
  );
}
