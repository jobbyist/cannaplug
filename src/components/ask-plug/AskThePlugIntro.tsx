import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BadgeCheck, MessageCircleQuestion, ShoppingBag, Sparkles } from "lucide-react";
import { AGE_GATE_KEY, ageGateNeeded } from "@/components/age-gate-logic";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/useAuth";
import {
  INTRO_FEATURE,
  PREVIEW_FEATURE,
  isIntroPath,
  isStorefrontPath,
} from "@/lib/ask-plug-access";
import { markAskThePlugSeenFn } from "@/lib/chat.functions";
import { tourPending } from "@/lib/tour-logic";
import { PlugMark } from "./PlugMark";
import {
  openAskThePlug,
  openAskThePlugOnArrival,
  plugStatusKey,
  usePlugStatus,
} from "./plug-status";

const ageConfirmed = (path: string) => {
  try {
    const v = Number(window.localStorage.getItem(AGE_GATE_KEY));
    return !ageGateNeeded(
      path,
      navigator.userAgent,
      Number.isFinite(v) && v > 0 ? v : null,
      Date.now(),
    );
  } catch {
    return true;
  }
};

/**
 * One-time launch announcement for Ask The Plug, shown to every member (existing and new) the next time they are
 * signed in on the storefront or their account page:
 *   - verified members get the full intro with "Ask The Plug now" (opens the chat; from /account it goes to the shop);
 *   - members not yet verified get a short preview with "Verify my ID" (only on the storefront, so it never gets in
 *     the way of the ID upload on their account page), and later the full intro once, after approval.
 * Seen state is stored on the server (member_feature_seen), so it shows once per member on any device.
 */
export function AskThePlugIntro() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const status = usePlugStatus(userId);
  const [open, setOpen] = useState(false);
  const recorded = useRef(false);

  const variant = status.data?.available ? status.data.intro : null;
  // Never on top of the new-member portal tour (it runs on /account while the flag is "pending").
  const allowedHere =
    tourPending(user) && pathname.replace(/\/+$/, "") === "/account"
      ? false
      : variant === "full"
        ? isIntroPath(pathname)
        : variant === "preview"
          ? isStorefrontPath(pathname)
          : false;

  // Wait a moment after the page settles, and never on top of the 18+ question.
  useEffect(() => {
    if (!variant || !allowedHere || open) return;
    const timer = window.setInterval(() => {
      if (ageConfirmed(pathname)) {
        window.clearInterval(timer);
        setOpen(true);
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [variant, allowedHere, open, pathname]);

  useEffect(() => {
    recorded.current = false;
  }, [userId]);

  if (!variant || !userId) return null;
  const feature = variant === "full" ? INTRO_FEATURE : PREVIEW_FEATURE;

  const record = (action: "opened" | "dismissed") => {
    if (recorded.current) return;
    recorded.current = true;
    queryClient.setQueryData(plugStatusKey(userId), (old: typeof status.data) =>
      old ? { ...old, intro: null } : old,
    );
    void markAskThePlugSeenFn({
      data: { feature, action, idempotencyKey: `${feature}:${action}:${userId}` },
    }).catch(() => {
      recorded.current = false; // try again next time rather than lose it
    });
  };

  const close = (action: "opened" | "dismissed") => {
    record(action);
    setOpen(false);
  };

  const primary = () => {
    close("opened");
    if (variant === "preview") {
      void navigate({ to: "/account" });
      return;
    }
    if (isStorefrontPath(pathname)) window.setTimeout(() => openAskThePlug(), 150);
    else {
      openAskThePlugOnArrival();
      void navigate({ to: "/shop" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close("dismissed")}>
      <DialogContent className="plug-intro max-w-md overflow-hidden border-0 p-0">
        <div className="plug-intro-hero">
          <span className="plug-intro-pill">New on Cannaplug</span>
          <PlugMark size={72} />
          <DialogTitle className="plug-intro-title">
            Ask The Plug <span aria-hidden="true">🔌</span>
          </DialogTitle>
          <DialogDescription className="plug-intro-sub">
            {variant === "full"
              ? "Your AI budtender. Tell it what you're after and get matched with the right bud from today's menu."
              : "Our new AI budtender is here. Verify your ID to unlock personal picks from today's menu."}
          </DialogDescription>
        </div>
        <ul className="plug-intro-points">
          <li>
            <MessageCircleQuestion size={18} /> Chat like you would with a friend behind the counter
          </li>
          <li>
            <Sparkles size={18} /> A few quick questions, then picks that fit your taste and budget
          </li>
          <li>
            <ShoppingBag size={18} /> Only what's in stock now, with prices. Add to cart in one tap
          </li>
          {variant === "preview" && (
            <li>
              <BadgeCheck size={18} /> For verified members: one quick ID check unlocks it
            </li>
          )}
        </ul>
        <div className="plug-intro-actions">
          <button type="button" className="plug-intro-cta" onClick={primary}>
            {variant === "full" ? "Ask The Plug now" : "Verify my ID"} <ArrowRight size={16} />
          </button>
          <button type="button" className="plug-intro-later" onClick={() => close("dismissed")}>
            Maybe later
          </button>
          <p className="plug-intro-legal">AI guidance only, not medical advice. For adults 18+.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
