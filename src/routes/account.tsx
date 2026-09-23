import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import {
  BadgeCheck, Bell, CalendarClock, CircleUserRound, CreditCard, Headphones,
  Heart, LayoutDashboard, ListOrdered, LogOut, MapPin, Package,
  Settings, ShieldCheck, ShoppingBag, Sparkles, Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { DashboardSidebar, type SidebarItem } from "@/components/dashboard/Sidebar";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { rand } from "@/lib/cart";
import { mockOrders, mockProfile, products } from "@/lib/mock-data";
import heroImage from "@/assets/cannaplug-hero.jpg";
import logoImage from "@/assets/cannaplug-logo.png";
import logoImageWhite from "@/assets/cannaplug-logo-white.png";

export const Route = createFileRoute("/account")({
  head: () => ({ meta: [{ title: "My Account | CannaPlug" }] }),
  component: AccountPage,
});

function AccountPage() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Loading your account…</p>
      </div>
    );
  }

  return user ? <MemberPortal /> : <AuthPanel />;
}

function AuthPanel() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName } },
        });
        if (signUpError) throw signUpError;
        setNotice("Account created — check your inbox to confirm your email, then sign in.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="site">
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
        <div className="relative hidden overflow-hidden bg-charcoal lg:block">
          <img src={heroImage} alt="Premium cannabis flower at CannaPlug" className="absolute inset-0 h-full w-full object-cover opacity-70" />
          <div className="absolute inset-0 bg-gradient-to-t from-charcoal via-charcoal/40 to-transparent" />
          <div className="relative flex h-full flex-col justify-between p-10 text-primary-foreground">
            <Link to="/">
              <img src={logoImageWhite} alt="CannaPlug" className="h-7 w-auto" />
            </Link>
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-sage">Good Plants, Great People.</p>
              <h1 className="font-display text-4xl font-extrabold leading-[0.95]">
                {mode === "signin" ? <>Welcome<br />back.</> : <>Join the<br />community.</>}
              </h1>
              <p className="mt-3 max-w-sm text-sm text-primary-foreground/80">
                {mode === "signin"
                  ? "Log in to your account and continue your cannabis journey."
                  : "Create an account to track orders, save products and earn rewards."}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-center px-6 py-16">
          <div className="w-full max-w-sm">
            <Link to="/" className="mb-8 block lg:hidden">
              <img src={logoImage} alt="CannaPlug" className="h-7 w-auto" />
            </Link>
            <h2 className="font-display text-2xl font-extrabold uppercase">{mode === "signin" ? "Sign in" : "Create account"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "signin" ? "New to CannaPlug?" : "Already have an account?"}{" "}
              <button type="button" className="font-semibold text-primary underline-offset-2 hover:underline" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
                {mode === "signin" ? "Create an account" : "Sign in instead"}
              </button>
            </p>

            <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
              {mode === "signup" && (
                <div className="grid gap-1.5">
                  <Label htmlFor="fullName">Full name</Label>
                  <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" required />
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="email">Email address</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
              </div>
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  {mode === "signin" && <span className="text-xs text-muted-foreground">Forgot password?</span>}
                </div>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" required minLength={6} />
              </div>

              {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}
              {notice && <p className="rounded-md bg-primary/10 px-3 py-2 text-xs text-primary">{notice}</p>}

              <Button type="submit" size="lg" disabled={submitting} className="mt-1 w-full">
                {submitting ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
              </Button>
            </form>

            <div className="mt-8 grid grid-cols-3 gap-3 border-t border-border pt-6 text-center text-[0.62rem] font-semibold uppercase text-muted-foreground">
              <div className="flex flex-col items-center gap-2"><ShieldCheck size={18} className="text-primary" />Lab tested &amp; certified</div>
              <div className="flex flex-col items-center gap-2"><Truck size={18} className="text-primary" />Discreet delivery</div>
              <div className="flex flex-col items-center gap-2"><Headphones size={18} className="text-primary" />Expert support</div>
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
  const [tab, setTab] = useState("dashboard");
  const displayName = (user?.user_metadata?.["full_name"] as string | undefined) ?? mockProfile.full_name;
  const rewardsPercent = Math.round((mockProfile.rewardsPoints / (mockProfile.rewardsPoints + mockProfile.rewardsToNextTier)) * 100);
  const saved = products.slice(0, 3);
  const recommended = products.slice(3, 6);

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
          <button onClick={() => void signOut()} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-destructive">
            <LogOut size={17} /> Log Out
          </button>
        }
      />

      <main className="flex-1 overflow-y-auto px-4 pb-24 pt-6 sm:px-8 sm:pt-8 md:pb-8">
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-primary text-primary-foreground"><CircleUserRound size={22} /></span>
            <div>
              <p className="text-xs text-muted-foreground">Welcome back,</p>
              <p className="font-display text-base font-bold">{displayName}</p>
            </div>
          </div>
          <Badge variant="outline" className="hidden items-center gap-1 sm:flex"><Sparkles size={12} /> Rewards Member</Badge>
        </header>

        {tab === "dashboard" && (
          <div className="flex flex-col gap-6">
            <section className="grid grid-cols-1 gap-6 overflow-hidden rounded-2xl bg-primary text-primary-foreground lg:grid-cols-[1.4fr_1fr]">
              <div className="relative flex flex-col justify-center gap-4 p-8">
                <img src={heroImage} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />
                <div className="relative">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-sage">Quality cannabis.</p>
                  <h1 className="font-display text-3xl font-extrabold leading-[0.95] sm:text-4xl">REAL PEOPLE.</h1>
                  <p className="mt-3 max-w-sm text-sm text-primary-foreground/80">Thanks for being part of our community. Here's what's happening with your account.</p>
                  <Link to="/shop"><Button variant="gold" size="sm" className="mt-4">View rewards</Button></Link>
                </div>
              </div>
              <div className="flex flex-col items-center justify-center gap-2 p-8">
                <div className="relative grid h-32 w-32 place-items-center rounded-full" style={{ background: `conic-gradient(var(--premium) ${rewardsPercent}%, color-mix(in oklab, var(--primary-foreground) 20%, transparent) 0)` }}>
                  <div className="grid h-24 w-24 place-items-center rounded-full bg-primary text-center">
                    <span className="font-display text-2xl font-extrabold">{mockProfile.rewardsPoints}</span>
                    <span className="text-[0.6rem] uppercase text-primary-foreground/70">points</span>
                  </div>
                </div>
                <p className="text-xs text-primary-foreground/80">{mockProfile.rewardsToNextTier} points to next reward</p>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Link to="/shop" className="flex items-center gap-3 rounded-xl border border-border bg-card p-5 transition hover:border-primary">
                <ShoppingBag className="text-primary" /><div><p className="text-sm font-bold">Shop Now</p><p className="text-xs text-muted-foreground">Browse the full range</p></div>
              </Link>
              <Link to="/shop" className="flex items-center gap-3 rounded-xl border border-border bg-card p-5 transition hover:border-primary">
                <Package className="text-primary" /><div><p className="text-sm font-bold">View Menu</p><p className="text-xs text-muted-foreground">Explore categories</p></div>
              </Link>
              <button onClick={() => setTab("orders")} className="flex items-center gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary">
                <Truck className="text-primary" /><div><p className="text-sm font-bold">Track Order</p><p className="text-xs text-muted-foreground">Check delivery status</p></div>
              </button>
            </section>

            <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-1">
                <div className="mb-3 flex items-center justify-between"><h3 className="font-display text-sm font-bold uppercase">Recent Orders</h3><button onClick={() => setTab("orders")} className="text-xs font-semibold text-primary">View all</button></div>
                <ul className="flex flex-col gap-3">
                  {mockOrders.map((order) => (
                    <li key={order.id} className="flex items-center justify-between text-xs">
                      <div><p className="font-semibold">{order.order_number}</p><p className="text-muted-foreground">{new Date(order.created_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}</p></div>
                      <Badge variant={order.status === "Delivered" ? "default" : "secondary"}>{order.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-1">
                <div className="mb-3 flex items-center justify-between"><h3 className="font-display text-sm font-bold uppercase">Saved Products</h3><button onClick={() => setTab("saved")} className="text-xs font-semibold text-primary">View all</button></div>
                <ul className="flex flex-col gap-3">
                  {saved.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 text-xs">
                      <img src={p.image} alt="" className="h-10 w-10 rounded-lg object-cover" />
                      <div className="flex-1"><p className="font-semibold">{p.name}</p><p className="text-muted-foreground">{p.subcategory}</p></div>
                      <b>{rand(p.price_rand)}</b>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-1">
                <div className="mb-3 flex items-center justify-between"><h3 className="font-display text-sm font-bold uppercase">Recommended</h3><Link to="/shop" className="text-xs font-semibold text-primary">View all</Link></div>
                <ul className="flex flex-col gap-3">
                  {recommended.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 text-xs">
                      <img src={p.image} alt="" className="h-10 w-10 rounded-lg object-cover" />
                      <div className="flex-1"><p className="font-semibold">{p.name}</p><p className="text-muted-foreground">{p.category}</p></div>
                      <b>{rand(p.price_rand)}</b>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </div>
        )}

        {tab === "orders" && (
          <div className="flex flex-col gap-4">
            <h2 className="font-display text-lg font-bold uppercase">Order history</h2>
            {mockOrders.map((order) => (
              <div key={order.id} className="rounded-xl border border-border bg-card p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div><p className="font-semibold">{order.order_number}</p><p className="text-xs text-muted-foreground">{new Date(order.created_at).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}</p></div>
                  <Badge variant={order.status === "Delivered" ? "default" : "secondary"}>{order.status}</Badge>
                </div>
                <ul className="mb-3 flex flex-col gap-1 text-xs text-muted-foreground">
                  {order.items.map((item) => <li key={item.product_name}>{item.quantity} × {item.product_name}</li>)}
                </ul>
                <p className="text-right text-sm font-bold">{rand(order.total_rand)}</p>
              </div>
            ))}
          </div>
        )}

        {tab === "saved" && (
          <div>
            <h2 className="mb-4 font-display text-lg font-bold uppercase">Saved products</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
                  <img src={p.image} alt="" className="h-14 w-14 rounded-lg object-cover" />
                  <div className="flex-1"><p className="text-sm font-semibold">{p.name}</p><p className="text-xs text-muted-foreground">{p.subcategory}</p></div>
                  <b className="text-sm">{rand(p.price_rand)}</b>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "rewards" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-2 font-display text-lg font-bold uppercase">Rewards &amp; loyalty</h2>
            <p className="mb-4 text-sm text-muted-foreground">Earn 1 point per R10 spent. Redeem points for products and exclusive drops.</p>
            <div className="mb-2 flex items-center justify-between text-xs font-semibold"><span>{mockProfile.rewardsPoints} points</span><span>{mockProfile.rewardsPoints + mockProfile.rewardsToNextTier} points</span></div>
            <Progress value={rewardsPercent} />
            <p className="mt-2 text-xs text-muted-foreground">{mockProfile.rewardsToNextTier} points to your next reward tier.</p>
          </div>
        )}

        {tab === "addresses" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-display text-lg font-bold uppercase">Delivery addresses</h2>
            <div className="flex items-start gap-3 rounded-lg border border-border p-4">
              <MapPin className="mt-0.5 text-primary" size={18} />
              <div><p className="text-sm font-semibold">Home</p><p className="text-xs text-muted-foreground">{mockProfile.address}</p></div>
            </div>
          </div>
        )}

        {tab === "payment" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-display text-lg font-bold uppercase">Payment methods</h2>
            <div className="flex items-center gap-3 rounded-lg border border-border p-4">
              <CreditCard className="text-primary" size={18} />
              <div><p className="text-sm font-semibold">Visa •••• 4821</p><p className="text-xs text-muted-foreground">Expires 08/28</p></div>
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-display text-lg font-bold uppercase">Account settings</h2>
            <div className="flex flex-col gap-4">
              <div className="grid gap-1.5"><Label>Full name</Label><Input defaultValue={displayName} /></div>
              <div className="grid gap-1.5"><Label>Email</Label><Input defaultValue={user?.email ?? ""} disabled /></div>
              <div className="grid gap-1.5"><Label>Phone</Label><Input defaultValue={mockProfile.phone ?? ""} /></div>
              <Button className="self-start" size="sm">Save changes</Button>
            </div>
          </div>
        )}

        {tab === "help" && (
          <div className="max-w-lg rounded-xl border border-border bg-card p-6">
            <h2 className="mb-2 font-display text-lg font-bold uppercase">Help &amp; support</h2>
            <p className="mb-4 text-sm text-muted-foreground">Our team is here Mon–Fri 09:00–19:00, Sat 09:00–20:00, Sun 09:00–15:00.</p>
            <div className="flex items-center gap-2 text-sm"><CalendarClock size={16} className="text-primary" /> +27 10 123 4567</div>
            <div className="mt-2 flex items-center gap-2 text-sm"><Bell size={16} className="text-primary" /> hello@cannaplug.co.za</div>
          </div>
        )}
      </main>
    </div>
  );
}
