import { StaffBadge } from "@/components/StaffBadge";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BadgeCheck,
  Bell,
  CalendarClock,
  CircleUserRound,
  CreditCard,
  FileText,
  Headphones,
  Heart,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  MapPin,
  Package,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DashboardSidebar, type SidebarItem } from "@/components/dashboard/Sidebar";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { rand } from "@/lib/cart";
import { VerificationBanner, VerificationPanel } from "@/components/account/VerificationPanel";
import { dobProblem } from "@/lib/verification-logic";
import { signupMetadata, signupProblem } from "@/lib/signup-logic";
import { checkReferralCodeFn, checkUsernameFn } from "@/lib/rewards.functions";
import { referralFromSearch } from "@/lib/rewards-logic";
import { useUsernameCheck } from "@/components/account/use-username-check";
import { LoyaltyPoster } from "@/components/rewards/LoyaltyPoster";
import { DateOfBirthField } from "@/components/account/DateOfBirthField";
import { getCatalogImage } from "@/fixtures/catalog-presentation";
import { useMemberAccount } from "@/components/account/use-member-account";
import { OrdersPanel } from "@/components/account/OrdersPanel";
import { ChangePasswordForm, ForgotPasswordForm } from "@/components/account/PasswordForms";
import { EmailPreferences } from "@/components/account/EmailPreferences";
import { AUTH_REDIRECT, authProblem } from "@/lib/auth-messages";
import { SavedPanel } from "@/components/account/SavedPanel";
import { RewardsPanel } from "@/components/account/RewardsPanel";
import { AddressesPanel } from "@/components/account/AddressesPanel";
import { ID_CREDITS_DEPLETED_MESSAGE, statusLabel } from "@/lib/member-logic";
import { idCreditsOpenFn } from "@/lib/id-credits.functions";
import heroImage from "@/assets/cannaplug-hero.jpg";
import logoImage from "@/assets/cannaplug-logo.png";
import logoImageWhite from "@/assets/cannaplug-logo-white.png";

export const Route = createFileRoute("/account")({
  head: () => ({ meta: [{ title: "My Account | CannaPlug" }] }),
  component: AccountPage,
});

function AccountPage() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Loading your account…</p>
      </div>
    );
  return user ? <MemberPortal /> : <AuthPanel />;
}

function AuthPanel() {
  const [mode, setMode] = useState<"signin" | "signup">(() =>
    typeof window !== "undefined" &&
    (referralFromSearch(window.location.search) ||
      new URLSearchParams(window.location.search).get("mode") === "signup")
      ? "signup"
      : "signin",
  );
  const [creditsOpen, setCreditsOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (mode !== "signup" || creditsOpen !== null) return;
    idCreditsOpenFn()
      .then((open) => setCreditsOpen(open))
      .catch(() => setCreditsOpen(true));
  }, [mode, creditsOpen]);
  const signupPaused = mode === "signup" && creditsOpen === false;
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [idNumber, setIdNumber] = useState("");
  // A referral link (/account?ref=username) opens sign-up with the code filled in.
  const [referral, setReferral] = useState(() =>
    typeof window !== "undefined" ? referralFromSearch(window.location.search) : "",
  );
  const [username, setUsername] = useState("");
  const usernameCheck = useUsernameCheck(mode === "signup" ? username : "");
  const [referralNote, setReferralNote] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const code = referral.trim();
    if (mode !== "signup" || !code) return setReferralNote(null);
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(code))
      return setReferralNote({ ok: false, text: "A referral code is a member's username." });
    let alive = true;
    const t = setTimeout(() => {
      checkReferralCodeFn({ data: { code } })
        .then((r) => {
          if (!alive) return;
          setReferralNote(
            r.valid
              ? {
                  ok: true,
                  text: "Referral code applied. Your friend earns a point when you spend R50.",
                }
              : r.reason === "inactive"
                ? {
                    ok: false,
                    text: "That member's referral code isn't active yet, so no points will be recorded. You can still sign up.",
                  }
                : {
                    ok: false,
                    text: "We couldn't find that referral code. Check the spelling or clear the box.",
                  },
          );
        })
        .catch(() => alive && setReferralNote(null));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [referral, mode]);
  const [dob, setDob] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fail = (err: unknown) => {
    const p = authProblem(err instanceof Error ? err.message : String(err ?? ""));
    setError(p.message);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signin") {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      } else {
        const fields = { firstName, lastName, email, phone, dob, idNumber, referral, username };
        const issue = signupProblem(fields, dobProblem(dob));
        if (issue) throw new Error(issue);
        // A username is optional; when given it must be free. A referral code must be one we know (typos would
        // lose the referral).
        if (username.trim()) {
          const { status } = await checkUsernameFn({ data: { username } });
          if (status !== "ok")
            throw new Error(
              status === "taken"
                ? "That username is taken. Try another."
                : "That username is not available. Try another.",
            );
        }
        if (referral.trim()) {
          const r = await checkReferralCodeFn({ data: { code: referral } });
          if (!r.valid && r.reason !== "inactive")
            throw new Error(
              "We couldn't find that referral code. Check the spelling or clear the box.",
            );
        }
        // New members need an ID check; when the shop has no credits left, sign-up is paused.
        if (!(await idCreditsOpenFn())) {
          setCreditsOpen(false);
          return;
        }
        const { data: created, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: signupMetadata(fields),
            emailRedirectTo: AUTH_REDIRECT,
          },
        });
        if (signUpError) throw signUpError;
        // Sign-up signs the member straight in and the ID upload is the first thing they see. If Supabase
        // ever returns no session, ask them to sign in rather than wait for an email.
        if (!created.session) {
          setMode("signin");
          setNotice("Account created. Sign in with your email and password to upload your ID.");
        }
      }
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="site">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
        <div className="relative hidden overflow-hidden bg-charcoal lg:block">
          <img
            src={heroImage}
            alt="Premium cannabis flower at CannaPlug"
            className="absolute inset-0 h-full w-full object-cover opacity-70"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-charcoal via-charcoal/40 to-transparent" />
          <div className="relative flex h-full flex-col justify-between p-10 text-primary-foreground">
            <Link to="/">
              <img src={logoImageWhite} alt="CannaPlug" className="h-7 w-auto" />
            </Link>
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-sage">
                Good Plants, Great People.
              </p>
              <h1 className="font-display text-4xl font-extrabold leading-[0.95]">
                {mode === "signin" ? (
                  <>
                    Welcome
                    <br />
                    back.
                  </>
                ) : (
                  <>
                    Join the
                    <br />
                    community.
                  </>
                )}
              </h1>
              <p className="mt-3 max-w-sm text-sm text-primary-foreground/80">
                {mode === "signin"
                  ? "Log in to your account and continue your cannabis journey."
                  : "Create an account to track orders and manage your membership."}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-center px-6 py-16">
          <div className="w-full max-w-sm">
            <Link to="/" className="mb-8 block lg:hidden">
              <img src={logoImage} alt="CannaPlug" className="h-7 w-auto" />
            </Link>
            {forgot && <ForgotPasswordForm onBack={() => setForgot(false)} />}
            {!forgot && (
              <>
                <h2 className="font-display text-2xl font-extrabold uppercase">
                  {mode === "signin" ? "Sign in" : "Create account"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {mode === "signin" ? "New to CannaPlug?" : "Already have an account?"}{" "}
                  <button
                    type="button"
                    className="font-semibold text-primary underline-offset-2 hover:underline"
                    onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
                  >
                    {mode === "signin" ? "Create an account" : "Sign in instead"}
                  </button>
                </p>
                <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
                  {mode === "signup" && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="grid gap-1.5">
                        <Label htmlFor="signup-first">Name</Label>
                        <Input
                          id="signup-first"
                          autoComplete="given-name"
                          value={firstName}
                          onChange={(e) => setFirstName(e.target.value)}
                          required
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="signup-last">Surname</Label>
                        <Input
                          id="signup-last"
                          autoComplete="family-name"
                          value={lastName}
                          onChange={(e) => setLastName(e.target.value)}
                          required
                        />
                      </div>
                    </div>
                  )}
                  {mode === "signup" && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="signup-username">Username (optional)</Label>
                      <Input
                        id="signup-username"
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={20}
                        value={username}
                        onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))}
                      />
                      <p
                        data-testid="username-status"
                        aria-live="polite"
                        className={
                          "text-[0.7rem] " +
                          (usernameCheck.state === "ok"
                            ? "text-primary"
                            : usernameCheck.state === "idle" || usernameCheck.state === "checking"
                              ? "text-muted-foreground"
                              : "text-destructive")
                        }
                      >
                        {usernameCheck.state === "checking"
                          ? "Checking…"
                          : usernameCheck.state === "idle"
                            ? "Optional. Set a username to get your own referral code and link: once it's set you can share it with friends and earn loyalty points when they join and spend R50. You can skip this now and set it in your account after you sign up. 3 to 20 letters, numbers or underscores; it becomes your referral code and can't be changed later."
                            : usernameCheck.message}
                      </p>
                    </div>
                  )}
                  {mode === "signup" && (
                    <div className="grid gap-1.5">
                      <DateOfBirthField
                        id="signup-dob"
                        label="Date of birth"
                        value={dob}
                        onChange={setDob}
                      />
                      <p className="text-[0.7rem] text-muted-foreground">
                        You must be 18 or older. We'll ask for a photo of your ID after you sign in
                        — it's reviewed by hand before you can order.
                      </p>
                    </div>
                  )}
                  <div className="grid gap-1.5">
                    <Label htmlFor="auth-email">Email address</Label>
                    <Input
                      id="auth-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  {mode === "signup" && (
                    <>
                      <div className="grid gap-1.5">
                        <Label htmlFor="signup-phone">Phone number</Label>
                        <Input
                          id="signup-phone"
                          type="tel"
                          autoComplete="tel"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          required
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="signup-id">ID / passport number</Label>
                        <Input
                          id="signup-id"
                          autoComplete="off"
                          value={idNumber}
                          onChange={(e) => setIdNumber(e.target.value)}
                          required
                        />
                        <p className="text-[0.7rem] text-muted-foreground">
                          Stored securely for age verification. It is never shown in emails.
                        </p>
                      </div>
                    </>
                  )}
                  <div className="grid gap-1.5">
                    <Label htmlFor="auth-password">Password</Label>
                    <Input
                      id="auth-password"
                      type="password"
                      autoComplete={mode === "signin" ? "current-password" : "new-password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={6}
                    />
                    {mode === "signin" && (
                      <button
                        type="button"
                        className="justify-self-end text-xs font-semibold text-primary underline-offset-2 hover:underline"
                        onClick={() => setForgot(true)}
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  {mode === "signup" && (
                    <div className="grid gap-1.5">
                      <Label htmlFor="signup-referral">Referral code (optional)</Label>
                      <Input
                        id="signup-referral"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        value={referral}
                        onChange={(e) => setReferral(e.target.value.replace(/\s/g, ""))}
                      />
                      <p
                        data-testid="referral-status"
                        aria-live="polite"
                        className={
                          "text-[0.7rem] " +
                          (referralNote
                            ? referralNote.ok
                              ? "text-primary"
                              : "text-destructive"
                            : "text-muted-foreground")
                        }
                      >
                        {referralNote?.text ??
                          "A friend's username. They earn a loyalty point when you spend R50."}
                      </p>
                      <p className="text-[0.7rem] text-muted-foreground">
                        Earn 1 loyalty point for every R50 you spend.{" "}
                        <a
                          className="font-semibold text-primary underline-offset-2 hover:underline"
                          href="/rewards"
                        >
                          How rewards work
                        </a>
                      </p>
                    </div>
                  )}
                  {error && (
                    <p
                      role="alert"
                      className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
                    >
                      {error}
                    </p>
                  )}
                  {notice && (
                    <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">
                      {notice}
                    </p>
                  )}
                  {signupPaused && (
                    <p
                      role="alert"
                      className="rounded-md border border-[#D4AF37]/60 bg-[#D4AF37]/10 px-3 py-2 text-xs font-semibold text-[#0B3D20] dark:text-[#D4AF37]"
                    >
                      {ID_CREDITS_DEPLETED_MESSAGE}
                    </p>
                  )}
                  <Button type="submit" size="lg" disabled={submitting || signupPaused}>
                    {submitting ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
                  </Button>
                </form>
              </>
            )}
            <div className="mt-8 grid grid-cols-3 gap-3 border-t border-border pt-6 text-center text-[0.62rem] font-semibold uppercase text-muted-foreground">
              <div className="flex flex-col items-center gap-2">
                <ShieldCheck size={18} className="text-primary" />
                Lab tested
              </div>
              <div className="flex flex-col items-center gap-2">
                <Truck size={18} className="text-primary" />
                Discreet delivery
              </div>
              <div className="flex flex-col items-center gap-2">
                <Headphones size={18} className="text-primary" />
                Expert support
              </div>
            </div>
            <p className="mt-6 flex items-center justify-center gap-1 text-[0.6rem] text-muted-foreground">
              <BadgeCheck size={12} /> Responsible consumption. 18+ only.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

const NAV_ITEMS: SidebarItem[] = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { id: "verification", icon: ShieldCheck, label: "ID Verification" },
  { id: "orders", icon: ListOrdered, label: "Orders" },
  { id: "saved", icon: Heart, label: "Saved Products" },
  { id: "rewards", icon: Sparkles, label: "Rewards & Loyalty" },
  { id: "addresses", icon: MapPin, label: "Delivery Addresses" },
  { id: "payment", icon: CreditCard, label: "Payment Methods" },
  { id: "settings", icon: Settings, label: "Account Settings" },
  { id: "help", icon: Headphones, label: "Help & Support" },
];

function MemberPortal() {
  const { user, signOut } = useAuth();
  // Arriving from a password-reset email (?reset=1): go straight to choosing a new password.
  const [resetting] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("reset"),
  );
  const [tab, setTab] = useState(() =>
    resetting
      ? "settings"
      : typeof window !== "undefined" && window.location.hash === "#rewards"
        ? "rewards"
        : "dashboard",
  );
  const [flash, setFlash] = useState<string | null>(null);
  const { data: account, error, reload } = useMemberAccount(user!.id);

  // Onboarding: a member who has never submitted an ID lands on the verification step first.
  const onboarded = useRef(false);
  useEffect(() => {
    if (!account || onboarded.current || resetting) return;
    onboarded.current = true;
    if (!account.verification && window.location.hash !== "#rewards") setTab("verification");
  }, [account, resetting]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(timer);
  }, [flash]);

  const displayName =
    (user?.user_metadata?.["full_name"] as string | undefined) ?? user?.email ?? "Member";
  const orders = account?.orders ?? [];
  const spend = orders
    .filter((order) => order.status === "completed")
    .reduce((sum, order) => sum + Number(order.total_rand), 0);
  const products = account?.products ?? [];
  const savedIds = new Set(account?.wishlist ?? []);
  const saved = (account?.wishlist ?? [])
    .map((id) => products.find((p) => p.id === id))
    .filter((p): p is (typeof products)[number] => Boolean(p))
    .slice(0, 3);
  const recommended = products.filter((p) => !savedIds.has(p.id)).slice(0, 3);

  return (
    <div className="site flex min-h-screen flex-col bg-background md:flex-row">
      <DashboardSidebar
        items={NAV_ITEMS}
        active={tab}
        onSelect={setTab}
        header={
          <Link to="/">
            <img src={logoImage} alt="CannaPlug" className="h-6 w-auto" />
          </Link>
        }
        footer={
          <>
            <Link
              to="/member/documents"
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FileText size={17} /> My documents
            </Link>
            <button
              onClick={() => void signOut()}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-destructive"
            >
              <LogOut size={17} /> Sign out
            </button>
          </>
        }
      />
      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-8 sm:pt-8 md:pb-8">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Good to see you</p>
            <h1 className="font-display text-2xl font-extrabold uppercase">{displayName}</h1>
          </div>
          <span className="grid h-10 w-10 place-items-center rounded-full bg-primary text-primary-foreground">
            <CircleUserRound size={18} />
          </span>
        </header>
        {flash && (
          <p
            role="status"
            className="mb-4 rounded-md bg-primary/10 px-3 py-2 text-xs font-medium text-primary"
          >
            {flash}
          </p>
        )}
        {error && !account && (
          <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}{" "}
            <button className="font-semibold underline" onClick={() => void reload()}>
              Retry
            </button>
          </p>
        )}
        {!account && !error && (
          <p className="text-sm text-muted-foreground">Loading your account…</p>
        )}
        {account && tab === "verification" && (
          <VerificationPanel
            verification={account.verification}
            defaultDob={(user?.user_metadata?.["date_of_birth"] as string | undefined) ?? ""}
            onDone={async () => {
              await reload();
              setFlash("Thanks — your ID has been submitted for review.");
            }}
          />
        )}
        {account && tab === "dashboard" && (
          <div className="flex flex-col gap-6">
            <VerificationBanner
              verification={account.verification}
              onOpen={() => setTab("verification")}
            />
            {account.rewards.can_change && (
              <div
                data-testid="username-generated-banner"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4"
              >
                <div className="flex items-start gap-3">
                  <Sparkles size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold">
                      Your username is <span className="font-mono">{account.rewards.username}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      We generated it for you. It&apos;s your referral code, and you can change it
                      once. Share your code or link with friends to earn loyalty points.
                    </p>
                  </div>
                </div>
                <Button size="sm" onClick={() => setTab("rewards")}>
                  Customise username
                </Button>
              </div>
            )}
            {!account.rewards.username && (
              <div
                data-testid="username-banner"
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#D4AF37]/60 bg-[#D4AF37]/10 p-4"
              >
                <div className="flex items-start gap-3">
                  <Sparkles size={18} className="mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold">
                      Set your username to get your referral code
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Once you set it, you can share your referral code and link with friends and
                      earn a loyalty point for every friend who joins and spends R50.
                    </p>
                  </div>
                </div>
                <Button size="sm" onClick={() => setTab("rewards")}>
                  Choose username
                </Button>
              </div>
            )}
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-xl bg-primary p-5 text-primary-foreground">
                <p className="text-xs uppercase opacity-70">Orders</p>
                <p className="font-display text-2xl font-extrabold">{orders.length}</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-xs uppercase text-muted-foreground">Total spent</p>
                <p className="font-display text-2xl font-extrabold">{rand(spend)}</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <p className="text-xs uppercase text-muted-foreground">Rewards points</p>
                <p className="font-display text-2xl font-extrabold">{account.loyalty.balance}</p>
              </div>
            </section>
            <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-xl border border-border bg-card p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-display text-sm font-bold uppercase">Recent Orders</h3>
                  <button
                    onClick={() => setTab("orders")}
                    className="text-xs font-semibold text-primary"
                  >
                    View all
                  </button>
                </div>
                {orders.length === 0 && (
                  <p className="text-xs text-muted-foreground">No orders yet.</p>
                )}
                {orders.slice(0, 5).map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between border-b border-border py-3 text-xs last:border-0"
                  >
                    <div>
                      <p className="flex items-center gap-2 font-semibold">
                        {order.order_number}
                        {order.staff_purchase && <StaffBadge />}
                      </p>
                      <p className="text-muted-foreground">
                        {new Date(order.created_at).toLocaleDateString("en-ZA")}
                      </p>
                    </div>
                    <Badge>{statusLabel(order.status)}</Badge>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="mb-3 font-display text-sm font-bold uppercase">Saved Products</h3>
                {saved.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Products you save will appear here.
                  </p>
                )}
                {saved.map((p) => (
                  <ProductRow key={p.id} product={p} />
                ))}
              </div>
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="mb-3 font-display text-sm font-bold uppercase">Recommended</h3>
                {recommended.map((p) => (
                  <ProductRow key={p.id} product={p} />
                ))}
              </div>
            </section>
          </div>
        )}
        {account && tab === "orders" && (
          <OrdersPanel account={account} reload={reload} notify={setFlash} />
        )}
        {account && tab === "saved" && <SavedPanel account={account} reload={reload} />}
        {account && tab === "rewards" && (
          <RewardsPanel account={account} reload={reload} onVerify={() => setTab("verification")} />
        )}
        {account && tab === "addresses" && <AddressesPanel account={account} reload={reload} />}
        {tab === "payment" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-display text-lg font-bold uppercase">Payment methods</h2>
            <p className="text-sm text-muted-foreground">
              Payments and POS are intentionally outside Milestone 2.
            </p>
          </div>
        )}
        {tab === "settings" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-display text-lg font-bold uppercase">Account settings</h2>
            <div className="grid gap-4">
              <div>
                <Label htmlFor="profile-email">Email</Label>
                <Input id="profile-email" value={user?.email ?? ""} disabled />
              </div>
              <div>
                <Label htmlFor="profile-name">Name</Label>
                <Input id="profile-name" value={displayName} disabled />
              </div>
            </div>
            <div className="mt-6 border-t border-border pt-6">
              <ChangePasswordForm
                {...(resetting
                  ? { intro: "You followed a reset link. Choose your new password now." }
                  : {})}
              />
            </div>
            <div className="mt-6 border-t border-border pt-6">
              <EmailPreferences />
            </div>
          </div>
        )}
        {tab === "help" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-2 font-display text-lg font-bold uppercase">Help & support</h2>
            <p className="text-sm text-muted-foreground">
              Our team is here Mon–Fri 09:00–19:00, Sat 09:00–20:00, Sun 09:00–15:00.
            </p>
            <div className="mt-3 flex items-center gap-2 text-sm">
              <CalendarClock size={16} className="text-primary" /> +27 68 291 2107
            </div>
            <div className="mt-2 flex items-center gap-2 text-sm">
              <Bell size={16} className="text-primary" /> info@cannaplug012.co.za
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ProductRow({
  product,
}: {
  product: {
    id: string;
    name: string;
    category: string;
    price_rand: number;
    image_url?: string | null;
  };
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border py-3 last:border-0">
      <img
        src={product.image_url ?? getCatalogImage(product.category)}
        alt={product.name}
        width={40}
        height={40}
        className="h-10 w-10 rounded-lg object-cover"
      />
      <div className="flex-1 text-xs">
        <p className="font-semibold">{product.name}</p>
        <p className="text-muted-foreground">{product.category}</p>
      </div>
      <b>{rand(Number(product.price_rand))}</b>
    </div>
  );
}
