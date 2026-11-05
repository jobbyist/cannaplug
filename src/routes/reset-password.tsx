import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { ChangePasswordForm, ForgotPasswordForm } from "@/components/account/PasswordForms";
import { recoveryLinkProblem, takeRecoveryMarker } from "@/lib/auth-messages";
import { getMyStaffAccessFn } from "@/lib/admin.functions";
import logoImage from "@/assets/cannaplug-logo.png";

/**
 * Where a password-reset email lands. It does one thing: choose a new password. Supabase signs the person in from
 * the link (the token is in the URL hash, or a `?code=` if PKCE is ever switched on); this page waits for that,
 * explains an expired or used link in plain words, and sends members to their account and staff to /admin when
 * done. No age gate, tour or other popup appears here (see age-gate-logic.ts).
 */
export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [{ title: "Choose a new password | CannaPlug" }, { name: "robots", content: "noindex" }],
  }),
  component: ResetPasswordPage,
});

/** How long to wait for Supabase to read the link before saying there is no usable link. */
const LINK_WAIT_MS = 4000;

type Phase =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "signed_in" }
  | { kind: "bad_link"; message: string }
  | { kind: "done"; destination: "/account" | "/admin" };

export function ResetPasswordPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  useEffect(() => {
    const problem = recoveryLinkProblem(window.location.hash, window.location.search);
    if (problem) {
      setPhase({ kind: "bad_link", message: problem });
      return;
    }
    let settled = false;
    const ready = () => {
      if (settled) return;
      settled = true;
      setPhase({ kind: "ready" });
    };
    // A session alone is not enough: someone simply signed in should change their password in their account, not
    // here. A session counts only with a recovery signal: the event itself, a recovery token in this URL, or the
    // marker useAuth leaves when it moves a recovery link here from another page.
    const recoveryInUrl =
      /(?:^|[#&])type=recovery(?:&|$)/.test(window.location.hash) ||
      new URLSearchParams(window.location.search).has("code");
    const recoveryHandedOver = takeRecoveryMarker();
    const signedInOnly = () => {
      if (settled) return;
      settled = true;
      setPhase({ kind: "signed_in" });
    };
    const fromSession = () => (recoveryInUrl || recoveryHandedOver ? ready() : signedInOnly());
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") ready();
      else if (session && recoveryInUrl) ready();
    });
    const code = new URLSearchParams(window.location.search).get("code");
    if (code) {
      void supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error && !settled) {
          settled = true;
          setPhase({
            kind: "bad_link",
            message: recoveryLinkProblem("#error_code=otp_expired", "") ?? "",
          });
        }
      });
    }
    void supabase.auth.getSession().then(({ data: s }) => {
      // With a recovery token still in the URL, Supabase may not have read it yet: wait for its event.
      if (s.session && !(recoveryInUrl && !recoveryHandedOver)) fromSession();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setPhase({
        kind: "bad_link",
        message:
          "We couldn't find a reset link here. Open the link from your email again, or send yourself a new one below.",
      });
    }, LINK_WAIT_MS);
    return () => {
      clearTimeout(timer);
      data.subscription.unsubscribe();
    };
  }, []);

  const finished = async () => {
    // The token must not stay in the address bar or browser history.
    window.history.replaceState(null, "", window.location.pathname);
    let destination: "/account" | "/admin" = "/account";
    try {
      const { role } = await getMyStaffAccessFn();
      if (role) destination = "/admin";
    } catch {
      // A member, or the check failed: the account page is right either way.
    }
    setPhase({ kind: "done", destination });
  };

  return (
    <main className="site flex min-h-dvh flex-col items-center bg-background px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-10 text-foreground">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 block">
          <img src={logoImage} alt="CannaPlug" width={120} height={28} className="h-7 w-auto" />
        </Link>
        {phase.kind === "checking" && (
          <p role="status" className="text-sm text-muted-foreground">
            Checking your reset link…
          </p>
        )}
        {phase.kind === "ready" && (
          <div className="rounded-xl border border-border bg-card p-5">
            <ChangePasswordForm
              title="Choose a new password"
              intro="Pick a password you'll remember. Tap Show to check what you typed. If your phone offers to save it, say yes."
              onDone={() => void finished()}
            />
          </div>
        )}
        {phase.kind === "signed_in" && (
          <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
            <h1 className="font-display text-xl font-extrabold uppercase">You&apos;re signed in</h1>
            <p className="text-sm text-muted-foreground">
              This page is for reset links from your email. To change your password, go to Account
              settings.
            </p>
            <Button asChild size="lg">
              <a href="/account">Go to my account</a>
            </Button>
          </div>
        )}
        {phase.kind === "done" && (
          <div className="flex flex-col gap-4 rounded-xl border border-primary/40 bg-primary/5 p-5">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground">
              <KeyRound size={20} />
            </span>
            <h1 className="font-display text-xl font-extrabold uppercase">Password changed</h1>
            <p className="text-sm text-muted-foreground">
              You&apos;re signed in. Use your new password next time.
            </p>
            <Button asChild size="lg">
              <a href={phase.destination}>
                {phase.destination === "/admin" ? "Go to staff admin" : "Go to my account"}
              </a>
            </Button>
          </div>
        )}
        {phase.kind === "bad_link" && (
          <div className="flex flex-col gap-4">
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {phase.message}
            </p>
            <ForgotPasswordForm />
            <a
              href="/account"
              className="flex min-h-[44px] items-center justify-center text-sm font-semibold text-primary"
            >
              Back to sign in
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
